import { randomUUID } from 'node:crypto';

export type PromptSource = 'desktop' | 'web' | 'feishu';
export type ApprovalDecision = 'allow_once' | 'allow_turn' | 'deny';
export type ApprovalStatus =
  | 'pending'
  | 'allowed'
  | 'denied'
  | 'expired'
  | 'cancelled';
export type DangerousToolName = 'edit' | 'write' | 'powershell';

export interface ApprovalRecord {
  id: string;
  runId: string;
  turnId: string;
  toolName: DangerousToolName;
  source: PromptSource;
  cwd: string;
  summary: string;
  details: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
}

export interface ApprovalRequestInput {
  runId: string;
  turnId: string;
  source: PromptSource;
  cwd: string;
  toolName: string;
  input: Record<string, unknown>;
}

export type ApprovalOutcome =
  | { allowed: true; scope: 'once' | 'turn' }
  | { allowed: false; reason: string };

export type ApprovalEvent = {
  type: 'approval_requested' | 'approval_resolved' | 'approval_expired';
  approval: ApprovalRecord;
};

export class ApprovalError extends Error {
  constructor(
    readonly code: 'approval_not_found' | 'approval_not_pending',
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface ApprovalManagerOptions {
  timeoutMs?: number;
  clientTtlMs?: number;
  now?: () => number;
  setTimer?: (handler: () => void, timeoutMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

interface PendingApproval {
  record: ApprovalRecord;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: TimerHandle;
}

interface ActiveTurn {
  id: string;
  source: PromptSource;
}

const DANGEROUS_TOOLS = new Set<string>(['edit', 'write', 'powershell']);
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CLIENT_TTL_MS = 15_000;
const MAX_PREVIEW_CHARS = 2_000;
const MAX_RECORDS = 2_000;

function turnKey(runId: string, turnId: string): string {
  return `${runId}:${turnId}`;
}

function redactText(value: string): string {
  return value
    .replace(
      /((?:\$env:)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]');
}

function preview(value: unknown): string {
  if (typeof value !== 'string') return '';
  const safe = redactText(value);
  return safe.length > MAX_PREVIEW_CHARS
    ? `${safe.slice(0, MAX_PREVIEW_CHARS)}…`
    : safe;
}

function pathFrom(input: Record<string, unknown>): string {
  const value = input['path'] ?? input['file_path'];
  return typeof value === 'string' && value.trim() ? redactText(value) : '未知文件';
}

export function summarizeToolCall(
  toolName: DangerousToolName,
  input: Record<string, unknown>,
  cwd: string,
): { summary: string; details: Record<string, unknown> } {
  if (toolName === 'powershell') {
    const command = preview(input['command']);
    return {
      summary: command || '执行 PowerShell 命令',
      details: { command, cwd: redactText(cwd) },
    };
  }

  const path = pathFrom(input);
  if (toolName === 'write') {
    const content = typeof input['content'] === 'string' ? input['content'] : '';
    return {
      summary: `写入文件 ${path}（${content.length} 个字符）`,
      details: {
        path,
        cwd: redactText(cwd),
        contentLength: content.length,
        contentPreview: preview(content),
      },
    };
  }

  return {
    summary: `修改文件 ${path}`,
    details: {
      path,
      cwd: redactText(cwd),
      oldText: preview(input['oldText'] ?? input['old_text']),
      newText: preview(input['newText'] ?? input['new_text']),
    },
  };
}

function cloneRecord(record: ApprovalRecord): ApprovalRecord {
  return { ...record, details: { ...record.details } };
}

export class ApprovalManager {
  private readonly timeoutMs: number;
  private readonly clientTtlMs: number;
  private readonly now: () => number;
  private readonly setTimer: (handler: () => void, timeoutMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly clients = new Map<string, number>();
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly turnGrants = new Set<string>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly listeners = new Set<(event: ApprovalEvent) => void>();

  constructor(options: ApprovalManagerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.clientTtlMs = options.clientTtlMs ?? DEFAULT_CLIENT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((handler, timeoutMs) => setTimeout(handler, timeoutMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  heartbeat(clientId: string): void {
    this.clients.set(clientId, this.now());
  }

  hasActiveClient(): boolean {
    const now = this.now();
    let active = false;
    for (const [id, seenAt] of this.clients) {
      if (now - seenAt < this.clientTtlMs) {
        active = true;
      } else {
        this.clients.delete(id);
      }
    }
    return active;
  }

  beginTurn(runId: string, turnId: string, source: PromptSource): void {
    const current = this.turns.get(runId);
    if (current && current.id !== turnId) {
      this.endTurn(runId, '上一轮任务已结束');
    }
    this.turns.set(runId, { id: turnId, source });
  }

  request(input: ApprovalRequestInput): Promise<ApprovalOutcome> {
    if (!DANGEROUS_TOOLS.has(input.toolName)) {
      return Promise.resolve({ allowed: true, scope: 'once' });
    }

    const activeTurn = this.turns.get(input.runId);
    if (!activeTurn || activeTurn.id !== input.turnId) {
      return Promise.resolve({ allowed: false, reason: '当前任务已经结束' });
    }

    const key = turnKey(input.runId, input.turnId);
    if (this.turnGrants.has(key)) {
      return Promise.resolve({ allowed: true, scope: 'turn' });
    }
    if (!this.hasActiveClient()) {
      return Promise.resolve({ allowed: false, reason: '需要在桌面客户端确认此操作' });
    }

    const toolName = input.toolName as DangerousToolName;
    const createdAtMs = this.now();
    const description = summarizeToolCall(toolName, input.input, input.cwd);
    const record: ApprovalRecord = {
      id: randomUUID(),
      runId: input.runId,
      turnId: input.turnId,
      toolName,
      source: input.source,
      cwd: redactText(input.cwd),
      summary: description.summary,
      details: description.details,
      status: 'pending',
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + this.timeoutMs).toISOString(),
    };

    const promise = new Promise<ApprovalOutcome>((resolve) => {
      const timer = this.setTimer(() => {
        const entry = this.pending.get(record.id);
        if (!entry) return;
        this.settle(entry, 'expired', { allowed: false, reason: '操作确认已超时' });
      }, this.timeoutMs);
      this.pending.set(record.id, { record, resolve, timer });
    });

    this.remember(record);
    this.emit({ type: 'approval_requested', approval: cloneRecord(record) });
    return promise;
  }

  decide(id: string, decision: ApprovalDecision): ApprovalRecord {
    const known = this.records.get(id);
    if (!known) {
      throw new ApprovalError('approval_not_found', 'Unknown approval request.', 404);
    }
    const entry = this.pending.get(id);
    if (!entry) {
      throw new ApprovalError('approval_not_pending', 'Approval is no longer pending.', 409);
    }

    if (decision === 'allow_turn') {
      const key = turnKey(entry.record.runId, entry.record.turnId);
      this.turnGrants.add(key);
      const sameTurn = [...this.pending.values()].filter(
        (candidate) =>
          candidate.record.runId === entry.record.runId &&
          candidate.record.turnId === entry.record.turnId,
      );
      for (const candidate of sameTurn) {
        this.settle(candidate, 'allowed', { allowed: true, scope: 'turn' });
      }
    } else if (decision === 'allow_once') {
      this.settle(entry, 'allowed', { allowed: true, scope: 'once' });
    } else {
      this.settle(entry, 'denied', { allowed: false, reason: '用户拒绝了此操作' });
    }

    return cloneRecord(this.records.get(id)!);
  }

  listPending(runId?: string): ApprovalRecord[] {
    return [...this.pending.values()]
      .filter((entry) => runId === undefined || entry.record.runId === runId)
      .map((entry) => cloneRecord(entry.record));
  }

  endTurn(runId: string, reason: string): void {
    const turn = this.turns.get(runId);
    if (turn) {
      this.turnGrants.delete(turnKey(runId, turn.id));
      this.turns.delete(runId);
    }
    const unsettled = [...this.pending.values()].filter(
      (entry) => entry.record.runId === runId,
    );
    for (const entry of unsettled) {
      this.settle(entry, 'cancelled', { allowed: false, reason });
    }
  }

  subscribe(listener: (event: ApprovalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private settle(
    entry: PendingApproval,
    status: Exclude<ApprovalStatus, 'pending'>,
    outcome: ApprovalOutcome,
  ): void {
    if (!this.pending.delete(entry.record.id)) return;
    this.clearTimer(entry.timer);
    entry.record.status = status;
    this.remember(entry.record);
    this.emit({
      type: status === 'expired' ? 'approval_expired' : 'approval_resolved',
      approval: cloneRecord(entry.record),
    });
    entry.resolve(outcome);
  }

  private remember(record: ApprovalRecord): void {
    this.records.set(record.id, record);
    while (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (!oldest) break;
      this.records.delete(oldest);
    }
  }

  private emit(event: ApprovalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Approval safety must not depend on an observer.
      }
    }
  }
}
