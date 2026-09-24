import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ReliabilityQueueInput,
  ReliabilityQueueItem,
  ReliabilityStatus,
} from './reliability.js';
import type { UsageLedgerEntry, UsageLedgerFilter, UsageLedgerRow } from './usage.js';
import type { ScheduledTask, TaskRun, TaskRunResult } from '../scheduler/task-store.js';
import type { MemoryInput, MemoryRecord, MemoryScope } from '../memory/memory-store.js';

const CURRENT_SCHEMA_VERSION = 6;

export interface StoredMessageInput {
  channelId: string;
  conversationId: string;
  channelMessageId?: string;
  senderId?: string;
  direction: 'inbound' | 'outbound';
  messageType?: string;
  content: string;
  status?: string;
  runId?: string;
}

export interface StoredConversation {
  id: string;
  channelId: string;
  conversationId: string;
  sessionFile: string | undefined;
}

export class SqliteStore {
  readonly path: string;
  readonly db: DatabaseSync;

  constructor(filePath = resolve(process.cwd(), 'data', 'db', 'messages.db')) {
    this.path = resolve(filePath);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  schemaVersion(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number };
    return Number(row.version);
  }

  tables(): string[] {
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  close(): void {
    this.db.close();
  }

  ensureConversation(channelId: string, conversationId: string): string {
    const existing = this.db.prepare(
      'SELECT id FROM conversations WHERE channel_id = ? AND conversation_id = ?',
    ).get(channelId, conversationId) as { id: string } | undefined;
    if (existing) {
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), existing.id);
      return existing.id;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO conversations(id, channel_id, conversation_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, channelId, conversationId, now, now);
    return id;
  }

  getConversation(channelId: string, conversationId: string): StoredConversation | undefined {
    const row = this.db.prepare(`
      SELECT id, channel_id, conversation_id, session_file
      FROM conversations WHERE channel_id = ? AND conversation_id = ?
    `).get(channelId, conversationId) as {
      id: string; channel_id: string; conversation_id: string; session_file: string | null;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      channelId: row.channel_id,
      conversationId: row.conversation_id,
      sessionFile: row.session_file ?? undefined,
    };
  }

  setConversationSessionFile(channelId: string, conversationId: string, sessionFile: string): void {
    const id = this.ensureConversation(channelId, conversationId);
    this.db.prepare('UPDATE conversations SET session_file = ?, updated_at = ? WHERE id = ?')
      .run(sessionFile, new Date().toISOString(), id);
  }

  appendMessage(input: StoredMessageInput): string {
    const conversationRowId = this.ensureConversation(input.channelId, input.conversationId);
    const id = randomUUID();
    try {
      this.db.prepare(`
        INSERT INTO messages(
          id, conversation_row_id, channel_message_id, sender_id, direction,
          message_type, content, status, run_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        conversationRowId,
        input.channelMessageId ?? null,
        input.senderId ?? null,
        input.direction,
        input.messageType ?? 'text',
        input.content,
        input.status ?? 'received',
        input.runId ?? null,
        new Date().toISOString(),
      );
      return id;
    } catch (error) {
      if (input.channelMessageId) {
        const duplicate = this.db.prepare(`
          SELECT id FROM messages
          WHERE conversation_row_id = ? AND channel_message_id = ? AND direction = ?
        `).get(conversationRowId, input.channelMessageId, input.direction) as { id: string } | undefined;
        if (duplicate) return duplicate.id;
      }
      throw error;
    }
  }

  enqueueReliability(input: ReliabilityQueueInput): string {
    const existing = this.db.prepare(
      'SELECT id FROM reliability_queue WHERE idempotency_key = ?',
    ).get(input.idempotencyKey) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO reliability_queue(
        id, channel_id, conversation_id, idempotency_key, payload_json,
        status, attempts, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(
      id,
      input.channelId,
      input.conversationId,
      input.idempotencyKey,
      JSON.stringify(input.payload),
      input.nextAttemptAt,
      now,
      now,
    );
    return id;
  }

  claimReliability(now: string, limit = 50): ReliabilityQueueItem[] {
    const rows = this.db.prepare(`
      SELECT id FROM reliability_queue
      WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?
      ORDER BY next_attempt_at, created_at
      LIMIT ?
    `).all(now, limit) as Array<{ id: string }>;
    if (rows.length === 0) return [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claimed: ReliabilityQueueItem[] = [];
      for (const row of rows) {
        const result = this.db.prepare(`
          UPDATE reliability_queue
          SET status = 'sending', attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND status IN ('pending', 'failed')
        `).run(now, row.id);
        if (Number(result.changes) === 0) continue;
        const item = this.readReliability(row.id);
        if (item) claimed.push(item);
      }
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  markReliabilitySent(id: string): void {
    this.db.prepare(`
      UPDATE reliability_queue SET status = 'sent', updated_at = ? WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  markReliabilityFailed(
    id: string,
    error: string,
    nextAttemptAt: string,
    dead: boolean,
  ): void {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.readReliability(id);
      if (!row) {
        this.db.exec('COMMIT');
        return;
      }
      this.db.prepare(`
        INSERT INTO reliability_attempts(id, queue_id, attempt, error, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), id, row.attempts, error, now);
      this.db.prepare(`
        UPDATE reliability_queue
        SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
        WHERE id = ?
      `).run(dead ? 'dead' : 'failed', error, nextAttemptAt, now, id);
      this.db.exec('COMMIT');
    } catch (cause) {
      this.db.exec('ROLLBACK');
      throw cause;
    }
  }

  recoverReliability(now: string): number {
    const result = this.db.prepare(`
      UPDATE reliability_queue
      SET status = 'pending', next_attempt_at = ?, updated_at = ?
      WHERE status = 'sending'
    `).run(now, now);
    return Number(result.changes);
  }

  appendUsage(input: UsageLedgerEntry): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO usage_ledger(
        id, run_id, conversation_id, workspace_id, agent_profile_id,
        provider, model, input_tokens, output_tokens, cache_tokens,
        latency_ms, estimated_cost, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.runId,
      input.conversationId ?? null,
      input.workspaceId ?? null,
      input.agentProfileId ?? null,
      input.provider,
      input.model,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.cacheTokens ?? null,
      input.latencyMs ?? null,
      input.estimatedCost ?? null,
      input.createdAt,
    );
    return id;
  }

  listUsage(filter: UsageLedgerFilter = {}): UsageLedgerRow[] {
    const clauses: string[] = [];
    const params: Array<string> = [];
    if (filter.model) {
      clauses.push('model = ?');
      params.push(filter.model);
    }
    if (filter.from) {
      clauses.push('created_at >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      clauses.push('created_at <= ?');
      params.push(filter.to);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT id, run_id, conversation_id, workspace_id, agent_profile_id,
        provider, model, input_tokens, output_tokens, cache_tokens,
        latency_ms, estimated_cost, created_at
      FROM usage_ledger ${where} ORDER BY created_at, id
    `).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row['id']),
      runId: String(row['run_id']),
      ...(row['conversation_id'] === null ? {} : { conversationId: String(row['conversation_id']) }),
      ...(row['workspace_id'] === null ? {} : { workspaceId: String(row['workspace_id']) }),
      ...(row['agent_profile_id'] === null ? {} : { agentProfileId: String(row['agent_profile_id']) }),
      provider: String(row['provider']),
      model: String(row['model']),
      ...(row['input_tokens'] === null ? {} : { inputTokens: Number(row['input_tokens']) }),
      ...(row['output_tokens'] === null ? {} : { outputTokens: Number(row['output_tokens']) }),
      ...(row['cache_tokens'] === null ? {} : { cacheTokens: Number(row['cache_tokens']) }),
      ...(row['latency_ms'] === null ? {} : { latencyMs: Number(row['latency_ms']) }),
      ...(row['estimated_cost'] === null ? {} : { estimatedCost: Number(row['estimated_cost']) }),
      createdAt: String(row['created_at']),
    }));
  }

  upsertTask(input: ScheduledTask): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO scheduled_tasks(id, name, schedule, conversation_id, payload_json, enabled, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, schedule = excluded.schedule,
        conversation_id = excluded.conversation_id, payload_json = excluded.payload_json,
        enabled = excluded.enabled, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at
    `).run(input.id, input.name, input.schedule, input.conversationId, JSON.stringify(input.payload), input.enabled ? 1 : 0, input.nextRunAt, input.createdAt ?? now, now);
  }

  getDueTasks(now: string): ScheduledTask[] {
    const rows = this.db.prepare(`
      SELECT id, name, schedule, conversation_id, payload_json, enabled, next_run_at, created_at, updated_at
      FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at, id
    `).all(now) as Array<Record<string, unknown>>;
    return rows.map((row) => this.readTask(row));
  }

  claimTaskRun(taskId: string, now: string): TaskRun | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.db.prepare('SELECT id FROM scheduled_tasks WHERE id = ? AND enabled = 1 AND next_run_at <= ?').get(taskId, now);
      if (!task) { this.db.exec('COMMIT'); return undefined; }
      const active = this.db.prepare("SELECT id FROM task_runs WHERE task_id = ? AND status = 'running'").get(taskId);
      if (active) { this.db.exec('COMMIT'); return undefined; }
      const id = randomUUID();
      this.db.prepare("INSERT INTO task_runs(id, task_id, status, started_at) VALUES (?, ?, 'running', ?)").run(id, taskId, now);
      this.db.exec('COMMIT');
      return { id, taskId, status: 'running', startedAt: now };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
  }

  finishTaskRun(runId: string, result: TaskRunResult): void {
    const finishedAt = result.finishedAt ?? new Date().toISOString();
    this.db.prepare('UPDATE task_runs SET status = ?, run_id = ?, finished_at = ?, error = ? WHERE id = ? AND status = ?')
      .run(result.status, result.runId ?? null, finishedAt, result.error ?? null, runId, 'running');
  }

  getTaskRuns(taskId: string): TaskRun[] {
    const rows = this.db.prepare('SELECT id, task_id, run_id, status, started_at, finished_at, error FROM task_runs WHERE task_id = ? ORDER BY started_at, id').all(taskId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row['id']), taskId: String(row['task_id']),
      ...(row['run_id'] === null ? {} : { runId: String(row['run_id']) }),
      status: String(row['status']) as TaskRun['status'], startedAt: String(row['started_at']),
      ...(row['finished_at'] === null ? {} : { finishedAt: String(row['finished_at']) }),
      ...(row['error'] === null ? {} : { error: String(row['error']) }),
    }));
  }

  disableTask(id: string): void {
    this.db.prepare('UPDATE scheduled_tasks SET enabled = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  recoverScheduledTasks(now: string): string | undefined {
    this.db.prepare("UPDATE task_runs SET status = 'failed', finished_at = ?, error = ? WHERE status = 'running'")
      .run(now, 'recovered after process restart');
    const row = this.db.prepare('SELECT MIN(next_run_at) AS next_run_at FROM scheduled_tasks WHERE enabled = 1 AND next_run_at >= ?').get(now) as { next_run_at: string | null };
    return row.next_run_at ?? undefined;
  }

  insertMemory(input: MemoryInput): string {
    const id = randomUUID(); const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO memories(id, scope, scope_id, content, source, importance, access_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(id, input.scope, input.scopeId, input.content, input.source, input.importance ?? 0.5, now, now);
    return id;
  }

  searchMemories(scope: MemoryScope, scopeId: string, query: string): MemoryRecord[] {
    const rows = this.db.prepare(`SELECT id, scope, scope_id, content, source, importance, access_count, deleted_at, created_at, updated_at
      FROM memories WHERE scope = ? AND scope_id = ? AND deleted_at IS NULL AND content LIKE ? ORDER BY importance DESC, updated_at DESC`).all(scope, scopeId, `%${query}%`) as Array<Record<string, unknown>>;
    return rows.map((row) => this.readMemory(row));
  }

  touchMemory(id: string): void {
    this.db.prepare('UPDATE memories SET access_count = access_count + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(new Date().toISOString(), id);
  }

  softDeleteMemory(id: string): void {
    this.db.prepare('UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(new Date().toISOString(), new Date().toISOString(), id);
  }

  private readReliability(id: string): ReliabilityQueueItem | undefined {
    const row = this.db.prepare(`
      SELECT id, channel_id, conversation_id, idempotency_key, payload_json,
        status, attempts, next_attempt_at, last_error, created_at, updated_at
      FROM reliability_queue WHERE id = ?
    `).get(id) as {
      id: string; channel_id: string; conversation_id: string; idempotency_key: string;
      payload_json: string; status: ReliabilityStatus; attempts: number;
      next_attempt_at: string; last_error: string | null; created_at: string; updated_at: string;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      channelId: row.channel_id,
      conversationId: row.conversation_id,
      idempotencyKey: row.idempotency_key,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private readTask(row: Record<string, unknown>): ScheduledTask {
    return {
      id: String(row['id']), name: String(row['name']), schedule: String(row['schedule']),
      conversationId: String(row['conversation_id']), payload: JSON.parse(String(row['payload_json'])) as Record<string, unknown>,
      enabled: Number(row['enabled']) === 1, nextRunAt: String(row['next_run_at']),
      createdAt: String(row['created_at']), updatedAt: String(row['updated_at']),
    };
  }

  private readMemory(row: Record<string, unknown>): MemoryRecord {
    return {
      id: String(row['id']), scope: String(row['scope']) as MemoryScope, scopeId: String(row['scope_id']),
      content: String(row['content']), source: String(row['source']), importance: Number(row['importance']),
      accessCount: Number(row['access_count']),
      ...(row['deleted_at'] === null ? {} : { deletedAt: String(row['deleted_at']) }),
      createdAt: String(row['created_at']), updatedAt: String(row['updated_at']),
    };
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const version = this.schemaVersion();
    if (version >= CURRENT_SCHEMA_VERSION) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        session_id TEXT,
        session_file TEXT,
        workspace_id TEXT,
        agent_profile_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel_id, conversation_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_row_id TEXT NOT NULL REFERENCES conversations(id),
        channel_message_id TEXT,
        sender_id TEXT,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        message_type TEXT NOT NULL DEFAULT 'text',
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'received',
        run_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(conversation_row_id, channel_message_id, direction)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
        ON messages(conversation_row_id, created_at);
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        mode TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        model TEXT,
        thinking_level TEXT,
        system_prompt TEXT,
        tools_json TEXT NOT NULL DEFAULT '[]',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reliability_queue (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reliability_attempts (
        id TEXT PRIMARY KEY,
        queue_id TEXT NOT NULL REFERENCES reliability_queue(id),
        attempt INTEGER NOT NULL,
        error TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reliability_due
        ON reliability_queue(status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS usage_ledger (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        conversation_id TEXT,
        workspace_id TEXT,
        agent_profile_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_tokens INTEGER,
        latency_ms INTEGER,
        estimated_cost REAL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_model_created
        ON usage_ledger(model, created_at);
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
        ON scheduled_tasks(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES scheduled_tasks(id),
        run_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_task_runs_active
        ON task_runs(task_id, status);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'workspace', 'conversation')),
        scope_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_scope_updated ON memories(scope, scope_id, updated_at);
    `);
    if (version < 2) {
      const columns = this.db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'session_file')) {
        this.db.exec('ALTER TABLE conversations ADD COLUMN session_file TEXT');
      }
    }
    this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
      CURRENT_SCHEMA_VERSION,
      new Date().toISOString(),
    );
  }
}
