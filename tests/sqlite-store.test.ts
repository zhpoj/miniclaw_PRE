import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SqliteStore } from '../src/storage/sqlite.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SqliteStore', () => {
  it('creates the database directory, schema, and migration metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'miniclaw-db-'));
    dirs.push(dir);
    const store = new SqliteStore(join(dir, 'data', 'db', 'messages.db'));

    expect(store.path).toContain('messages.db');
    expect(store.schemaVersion()).toBe(1);
    expect(store.tables()).toEqual(expect.arrayContaining([
      'schema_migrations', 'conversations', 'messages', 'workspaces', 'agent_profiles',
    ]));
    store.close();
  });

  it('reopens without losing migration state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'miniclaw-db-'));
    dirs.push(dir);
    const path = join(dir, 'data', 'db', 'messages.db');
    const first = new SqliteStore(path);
    first.close();
    const second = new SqliteStore(path);
    expect(second.schemaVersion()).toBe(1);
    second.close();
  });

  it('deduplicates inbound channel messages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'miniclaw-db-'));
    dirs.push(dir);
    const store = new SqliteStore(join(dir, 'data', 'db', 'messages.db'));
    const input = {
      channelId: 'feishu',
      conversationId: 'oc_1',
      channelMessageId: 'om_1',
      senderId: 'ou_1',
      direction: 'inbound' as const,
      content: 'hello',
    };
    expect(store.appendMessage(input)).toBe(store.appendMessage(input));
    const row = store.db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number };
    expect(Number(row.count)).toBe(1);
    store.close();
  });
});
