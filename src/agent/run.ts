import { randomUUID } from 'node:crypto';

import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  type CreateAgentSessionOptions,
  DefaultResourceLoader,
  getAgentDir,
  type ModelRuntime,
  resolveCliModel,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

/** Thinking levels accepted by the pi runtime. */
export type AgentThinkingLevel = NonNullable<
  CreateAgentSessionOptions['thinkingLevel']
>;

/** Request payload accepted by the engine when creating a run. */
export interface AgentRunRequest {
  /** Working directory the agent operates in. Defaults to the engine cwd. */
  cwd?: string | undefined;
  /** Model reference, e.g. `anthropic/claude-sonnet-4-5` or `anthropic/claude-sonnet-4-5:high`. */
  model?: string | undefined;
  /** Overrides the thinking level parsed from the model reference. */
  thinkingLevel?: AgentThinkingLevel | undefined;
  /** Tool allowlist. Defaults to the engine defaults. */
  tools?: string[] | undefined;
  /** Replaces pi's discovered system prompt. */
  systemPrompt?: string | undefined;
  /** Persist the pi session to disk instead of keeping it in memory. */
  persistSession?: boolean | undefined;
}

/** Engine level defaults applied to every run. */
export interface AgentRunDefaults {
  cwd: string;
  agentDir?: string | undefined;
  tools: string[];
  persistSessions: boolean;
}

export type AgentRunStatus =
  | 'starting'
  | 'idle'
  | 'running'
  | 'error'
  | 'closed';

/** Normalized, JSON-safe view of a pi agent session event. */
export interface AgentEventRecord {
  seq: number;
  at: string;
  type: string;
  payload: unknown;
}

export interface AgentRunSnapshot {
  id: string;
  createdAt: string;
  cwd: string;
  status: AgentRunStatus;
  streaming: boolean;
  tools: string[];
  eventCount: number;
  model: { provider: string; id: string } | undefined;
  thinkingLevel: string | undefined;
  piSessionId: string | undefined;
  piSessionFile: string | undefined;
  lastError: string | undefined;
}

export interface PromptResult {
  accepted: boolean;
  mode: 'started' | 'queued';
}

/** Maximum number of events kept in memory per run (ring buffer). */
const MAX_EVENTS = 2000;

export class AgentEngineError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'AgentEngineError';
    this.code = code;
    this.status = status;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function serializePayload(event: AgentSessionEvent): unknown {
  const { type: _type, ...rest } = event as unknown as Record<string, unknown>;
  try {
    return JSON.parse(JSON.stringify(rest)) as unknown;
  } catch {
    return { unserializable: true };
  }
}

/**
 * Wraps a single pi `AgentSession`: owns its lifecycle, records a replayable
 * event log, and serializes prompt delivery so one turn runs at a time.
 */
export class AgentRun {
  readonly id: string;
  readonly createdAt: string;
  readonly cwd: string;
  readonly request: AgentRunRequest;

  private readonly tools: string[];
  private session: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly events: AgentEventRecord[] = [];
  private readonly listeners = new Set<(event: AgentEventRecord) => void>();
  private activeRun: Promise<void> | undefined;
  private seq = 0;
  private statusValue: AgentRunStatus = 'starting';
  private lastError: string | undefined;

  private constructor(request: AgentRunRequest, defaults: AgentRunDefaults) {
    this.id = randomUUID();
    this.createdAt = new Date().toISOString();
    this.cwd = request.cwd ?? defaults.cwd;
    this.request = request;
    this.tools = request.tools ?? defaults.tools;
  }

  static async create(
    modelRuntime: ModelRuntime,
    request: AgentRunRequest,
    defaults: AgentRunDefaults,
  ): Promise<AgentRun> {
    const run = new AgentRun(request, defaults);
    await run.initialize(modelRuntime, defaults);
    return run;
  }

  private async initialize(
    modelRuntime: ModelRuntime,
    defaults: AgentRunDefaults,
  ): Promise<void> {
    const options: CreateAgentSessionOptions = {
      cwd: this.cwd,
      modelRuntime,
      tools: this.tools,
      sessionManager: this.request.persistSession ?? defaults.persistSessions
        ? SessionManager.create(this.cwd)
        : SessionManager.inMemory(this.cwd),
    };

    const agentDir = defaults.agentDir;
    if (agentDir) options.agentDir = agentDir;

    if (this.request.model) {
      const resolved = resolveCliModel({
        cliModel: this.request.model,
        modelRuntime,
        ...(this.request.thinkingLevel
          ? { cliThinking: this.request.thinkingLevel }
          : {}),
      });
      if (resolved.error) {
        throw new AgentEngineError('model_unresolved', resolved.error, 400);
      }
      if (resolved.model) options.model = resolved.model;
      if (resolved.thinkingLevel) options.thinkingLevel = resolved.thinkingLevel;
    }

    if (this.request.systemPrompt) {
      const loader = new DefaultResourceLoader({
        cwd: this.cwd,
        agentDir: defaults.agentDir ?? getAgentDir(),
        systemPromptOverride: () => this.request.systemPrompt ?? '',
      });
      await loader.reload();
      options.resourceLoader = loader;
    }

    const { session } = await createAgentSession(options);
    this.session = session;
    this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
    this.statusValue = 'idle';
  }

  private handleEvent(event: AgentSessionEvent): void {
    const record: AgentEventRecord = {
      seq: this.seq++,
      at: new Date().toISOString(),
      type: event.type,
      payload: serializePayload(event),
    };

    this.events.push(record);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }

    if (event.type === 'agent_start') {
      this.statusValue = 'running';
    } else if (event.type === 'agent_settled' && this.statusValue !== 'closed') {
      this.statusValue = 'idle';
    }

    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // A faulty consumer must not break the agent loop.
      }
    }
  }

  get status(): AgentRunStatus {
    return this.statusValue;
  }

  get isBusy(): boolean {
    return this.activeRun !== undefined;
  }

  snapshot(): AgentRunSnapshot {
    const session = this.session;
    const model = session?.model;
    return {
      id: this.id,
      createdAt: this.createdAt,
      cwd: this.cwd,
      status: this.statusValue,
      streaming: session?.isStreaming ?? false,
      tools: session?.getActiveToolNames() ?? this.tools,
      eventCount: this.seq,
      model: model ? { provider: model.provider, id: model.id } : undefined,
      thinkingLevel: session?.thinkingLevel,
      piSessionId: session?.sessionId,
      piSessionFile: session?.sessionFile,
      lastError: this.lastError,
    };
  }

  /** Events recorded after `since` (exclusive). */
  eventsSince(since = 0): AgentEventRecord[] {
    return this.events.filter((event) => event.seq >= since);
  }

  /** Subscribe to live events. Returns an unsubscribe function. */
  subscribe(listener: (event: AgentEventRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Send a prompt. Returns once the run has been accepted or queued; the turn
   * itself continues in the background and is observable through events.
   */
  async prompt(
    text: string,
    options: { streamingBehavior?: 'steer' | 'followUp' } = {},
  ): Promise<PromptResult> {
    const session = this.requireSession();

    if (this.activeRun) {
      const behavior = options.streamingBehavior;
      if (!behavior) {
        throw new AgentEngineError(
          'run_busy',
          'The agent is still running. Pass streamingBehavior ("steer" or "followUp") to queue the message.',
          409,
        );
      }
      if (behavior === 'steer') {
        await session.steer(text);
      } else {
        await session.followUp(text);
      }
      return { accepted: true, mode: 'queued' };
    }

    this.lastError = undefined;
    this.statusValue = 'running';

    const promise = session
      .prompt(
        text,
        options.streamingBehavior
          ? { streamingBehavior: options.streamingBehavior }
          : {},
      )
      .then(() => {
        if (this.statusValue === 'running') this.statusValue = 'idle';
      })
      .catch((error: unknown) => {
        this.lastError = describeError(error);
        if (this.statusValue !== 'closed') this.statusValue = 'error';
      })
      .finally(() => {
        this.activeRun = undefined;
      });

    this.activeRun = promise;
    return { accepted: true, mode: 'started' };
  }

  /** Wait for the current turn to finish. */
  async awaitIdle(): Promise<void> {
    await this.activeRun;
  }

  /** Abort the in-flight turn. */
  async abort(): Promise<void> {
    const session = this.session;
    if (!session) return;
    await session.abort();
    if (this.statusValue !== 'closed') this.statusValue = 'idle';
  }

  /** Release the underlying pi session. */
  close(): void {
    if (this.statusValue === 'closed') return;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
    this.listeners.clear();
    this.statusValue = 'closed';
  }

  private requireSession(): AgentSession {
    if (!this.session) {
      throw new AgentEngineError(
        'run_closed',
        'This agent run is no longer active.',
        409,
      );
    }
    return this.session;
  }
}
