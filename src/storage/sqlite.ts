import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CURRENT_SCHEMA_VERSION = 1;

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
    `);
    this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
      CURRENT_SCHEMA_VERSION,
      new Date().toISOString(),
    );
  }
}
