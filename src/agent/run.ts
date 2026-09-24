import { randomUUID } from 'node:crypto';

import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  type CreateAgentSessionOptions,
  DefaultResourceLoader,
  type ExtensionFactory,
  getAgentDir,
  type InlineExtension,
  type ModelRuntime,
  resolveCliModel,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

import {
  ApprovalManager,
  type PromptSource,
} from './approval.js';

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

export interface PromptOptions {
  streamingBehavior?: 'steer' | 'followUp';
  source?: PromptSource;
}

interface ActiveTurn {
  id: string;
  source: PromptSource;
}

const APPROVAL_TOOLS = new Set(['edit', 'write', 'powershell']);

export function createApprovalExtension(context: {
  approvals: ApprovalManager;
  runId: string;
  cwd: string;
  getTurn: () => ActiveTurn | undefined;
}): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      if (!APPROVAL_TOOLS.has(event.toolName)) return undefined;
      const turn = context.getTurn();
      if (!turn) {
        return { block: true, reason: '当前没有可授权的任务' };
      }
      try {
        const outcome = await context.approvals.request({
          runId: context.runId,
          turnId: turn.id,
          source: turn.source,
          cwd: context.cwd,
          toolName: event.toolName,
          input: event.input as unknown as Record<string, unknown>,
        });
        return outcome.allowed
          ? undefined
          : { block: true, reason: outcome.reason };
      } catch {
        return { block: true, reason: '操作审批服务异常，已阻止执行' };
      }
    });
  };
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
  private readonly approvals: ApprovalManager;
  private session: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeApprovals: (() => void) | undefined;
  private readonly events: AgentEventRecord[] = [];
  private readonly listeners = new Set<(event: AgentEventRecord) => void>();
  private activeRun: Promise<void> | undefined;
  private seq = 0;
  private statusValue: AgentRunStatus = 'starting';
  private lastError: string | undefined;
  private activeTurn: ActiveTurn | undefined;

  private constructor(
    request: AgentRunRequest,
    defaults: AgentRunDefaults,
    approvals: ApprovalManager,
  ) {
    this.id = randomUUID();
    this.createdAt = new Date().toISOString();
    this.cwd = request.cwd ?? defaults.cwd;
    this.request = request;
    this.tools = request.tools ?? defaults.tools;
    this.approvals = approvals;
    this.unsubscribeApprovals = approvals.subscribe((event) => {
      if (event.approval.runId !== this.id) return;
      this.recordEvent(event.type, { approval: event.approval });
    });
  }

  static async create(
    modelRuntime: ModelRuntime,
    request: AgentRunRequest,
    defaults: AgentRunDefaults,
    approvals: ApprovalManager,
  ): Promise<AgentRun> {
    const run = new AgentRun(request, defaults, approvals);
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

    const approvalExtension: InlineExtension = {
      name: 'miniclaw-operation-approval',
      hidden: true,
      factory: createApprovalExtension({
        approvals: this.approvals,
        runId: this.id,
        cwd: this.cwd,
        getTurn: () => this.activeTurn,
      }),
    };
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: defaults.agentDir ?? getAgentDir(),
      ...(this.request.systemPrompt
        ? { systemPromptOverride: () => this.request.systemPrompt ?? '' }
        : {}),
      extensionFactories: [approvalExtension],
    });
    await loader.reload();
    options.resourceLoader = loader;

    const { session } = await createAgentSession(options);
    this.session = session;
    this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
    this.statusValue = 'idle';
  }

  private handleEvent(event: AgentSessionEvent): void {
    this.recordEvent(event.type, serializePayload(event));

    if (event.type === 'agent_start') {
      this.statusValue = 'running';
    } else if (event.type === 'agent_settled' && this.statusValue !== 'closed') {
      this.statusValue = 'idle';
      this.endActiveTurn('当前任务已结束');
    }
  }

  private recordEvent(type: string, payload: unknown): void {
    const record: AgentEventRecord = {
      seq: this.seq++,
      at: new Date().toISOString(),
      type,
      payload,
    };

    this.events.push(record);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
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
    options: PromptOptions = {},
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
    this.activeTurn = {
      id: randomUUID(),
      source: options.source ?? 'web',
    };
    this.approvals.beginTurn(this.id, this.activeTurn.id, this.activeTurn.source);

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
        this.endActiveTurn('任务执行失败');
      })
      .finally(() => {
        this.endActiveTurn('当前任务已结束');
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
    this.endActiveTurn('任务已中止');
    await session.abort();
    if (this.statusValue !== 'closed') this.statusValue = 'idle';
  }

  /** Release the underlying pi session. */
  close(): void {
    if (this.statusValue === 'closed') return;
    this.endActiveTurn('会话已关闭');
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
    this.unsubscribeApprovals?.();
    this.unsubscribeApprovals = undefined;
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

  private endActiveTurn(reason: string): void {
    if (!this.activeTurn) return;
    this.activeTurn = undefined;
    this.approvals.endTurn(this.id, reason);
  }
}
