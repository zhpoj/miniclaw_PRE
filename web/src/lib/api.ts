/**
 * Thin typed client for the MiniAgent HTTP API (runs / prompt / events).
 *
 * Requests go to `/api` by default, which the Vite dev server proxies to the
 * backend (see `vite.config.ts`). Set `VITE_API_BASE` to point somewhere else.
 */

const API_BASE = String(import.meta.env.VITE_API_BASE ?? '/api');

export type AgentRunStatus = 'starting' | 'idle' | 'running' | 'error' | 'closed';

export type StreamingBehavior = 'steer' | 'followUp';

export type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

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

/** One entry of the run event log returned by `GET /runs/:id/events`. */
export interface AgentEventRecord {
  seq: number;
  at: string;
  type: string;
  payload: unknown;
}

export interface CreateRunInput {
  cwd?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  systemPrompt?: string;
  persistSession?: boolean;
}

export interface PromptInput {
  text: string;
  streamingBehavior?: StreamingBehavior;
}

export interface PromptResult {
  id: string;
  accepted: boolean;
  mode: 'started' | 'queued';
}

export interface AgentEngineInfo {
  engine: string;
  version: string;
  cwd: string;
  mode: string;
  workspace: {
    hostPath: string | null;
    containerPath: string;
    exists: boolean;
  };
  defaultTools: string[];
  persistSessions: boolean;
  activeRuns: number;
  totalRuns: number;
}

export interface EngineHealth {
  status: string;
  engine: AgentEngineInfo;
}

/** Error carrying the HTTP status and the `error` code returned by the API. */
export class ApiError extends Error {
  status: number;
  code: string;
  issues: unknown | undefined;

  constructor(status: number, code: string, message: string, issues?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch (cause) {
    throw new ApiError(
      0,
      'network_error',
      `无法连接 Agent 服务（${API_BASE}）：${describeCause(cause)}`,
    );
  }

  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const payload = isRecord(body) ? body : {};
    const message =
      typeof payload.message === 'string'
        ? payload.message
        : `请求失败（HTTP ${response.status}）`;
    const code = typeof payload.error === 'string' ? payload.error : 'http_error';
    throw new ApiError(response.status, code, message, payload.issues);
  }

  return body as T;
}

function jsonInit(method: 'POST', body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** `GET /agent/health` - used for the header status strip. */
export function fetchHealth(): Promise<EngineHealth> {
  return request<EngineHealth>('/agent/health');
}

/** `GET /agent/runs` */
export function listRuns(): Promise<{ runs: AgentRunSnapshot[] }> {
  return request<{ runs: AgentRunSnapshot[] }>('/agent/runs');
}

/** `POST /agent/runs` */
export function createRun(input: CreateRunInput): Promise<AgentRunSnapshot> {
  return request<AgentRunSnapshot>('/agent/runs', jsonInit('POST', input));
}

/**
 * `GET /agent/runs/:id/events?since=<seq>`
 *
 * `since` is inclusive, so pass `lastSeq + 1` to receive only newer events.
 */
export function fetchEvents(
  runId: string,
  since = 0,
): Promise<{ run: AgentRunSnapshot; events: AgentEventRecord[] }> {
  const target = encodeURIComponent(runId);
  return request<{ run: AgentRunSnapshot; events: AgentEventRecord[] }>(
    `/agent/runs/${target}/events?since=${since}`,
  );
}

/** `POST /agent/runs/:id/prompt` */
export function sendPrompt(runId: string, input: PromptInput): Promise<PromptResult> {
  const target = encodeURIComponent(runId);
  return request<PromptResult>(`/agent/runs/${target}/prompt`, jsonInit('POST', input));
}

/** `GET /agent/runs/:id` - single run snapshot, used for the status card. */
export function fetchRun(runId: string): Promise<AgentRunSnapshot> {
  const target = encodeURIComponent(runId);
  return request<AgentRunSnapshot>(`/agent/runs/${target}`);
}

export interface RunSubscription {
  onRun?: (run: AgentRunSnapshot) => void;
  onEvent?: (event: AgentEventRecord) => void;
  onError?: (error: unknown) => void;
}

interface ParsedSSE {
  event: string;
  data: string;
}

/** Parse one SSE block (`event:` / `data:` lines, `:` comments ignored). */
function parseSSEBlock(block: string): ParsedSSE | null {
  let event = 'message';
  let data = '';
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      const payload = line.slice(5);
      data += (data ? '\n' : '') + (payload.startsWith(' ') ? payload.slice(1) : payload);
    }
  }
  if (!data) return null;
  return { event, data };
}

/**
 * Open the run event stream: `GET /api/agent/runs/:id/stream?since=<seq>`.
 *
 * The server sends an initial `run` snapshot, replays buffered events since
 * `since` (inclusive), then pushes live events. Returns an unsubscribe fn that
 * aborts the stream.
 */
export function subscribeRun(
  runId: string,
  since: number,
  handlers: RunSubscription,
): () => void {
  const target = encodeURIComponent(runId);
  const controller = new AbortController();
  const url = `${API_BASE}/agent/runs/${target}/stream?since=${since}`;

  void (async () => {
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (cause) {
      if (!controller.signal.aborted) handlers.onError?.(cause);
      return;
    }
    if (!response.ok || !response.body) {
      handlers.onError?.(
        new ApiError(response.status, 'stream_error', `事件流打开失败（HTTP ${response.status}）`),
      );
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSSEBlock(block);
          if (!parsed) continue;
          if (parsed.event === 'run') {
            try {
              handlers.onRun?.(JSON.parse(parsed.data) as AgentRunSnapshot);
            } catch {
              /* ignore malformed frame */
            }
          } else {
            try {
              handlers.onEvent?.(JSON.parse(parsed.data) as AgentEventRecord);
            } catch {
              /* ignore malformed frame */
            }
          }
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted) handlers.onError?.(cause);
    }
  })();

  return () => controller.abort();
}

