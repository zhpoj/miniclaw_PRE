import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SqliteStore } from '../src/storage/sqlite.js';

const dirs: string[] = [];
const stores: SqliteStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): SqliteStore {
  const dir = mkdtempSync(join(tmpdir(), 'miniclaw-reliability-'));
  dirs.push(dir);
  const store = new SqliteStore(join(dir, 'data', 'db', 'messages.db'));
  stores.push(store);
  return store;
}

describe('SqliteStore reliability queue', () => {
  it('deduplicates queue entries by idempotency key', () => {
    const store = makeStore();
    const input = {
      channelId: 'feishu', conversationId: 'chat_1', idempotencyKey: 'msg-1',
      payload: { text: 'hello' }, nextAttemptAt: '2026-09-24T00:00:00.000Z',
    };

    expect(store.enqueueReliability(input)).toBe(store.enqueueReliability(input));
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM reliability_queue').get()).toMatchObject({ count: 1 });
  });

  it('claims due pending entries and marks them sending', () => {
    const store = makeStore();
    const id = store.enqueueReliability({
      channelId: 'feishu', conversationId: 'chat_1', idempotencyKey: 'due-1',
      payload: { text: 'retry' }, nextAttemptAt: '2026-09-24T00:00:00.000Z',
    });

    const [item] = store.claimReliability('2026-09-24T00:01:00.000Z');
    expect(item).toMatchObject({ id, status: 'sending', attempts: 1 });
    expect(store.claimReliability('2026-09-24T00:01:00.000Z')).toEqual([]);
  });

  it('recovers in-flight entries after a restart', () => {
    const store = makeStore();
    const id = store.enqueueReliability({
      channelId: 'feishu', conversationId: 'chat_1', idempotencyKey: 'crash-1',
      payload: { text: 'recover' }, nextAttemptAt: '2026-09-24T00:00:00.000Z',
    });
    store.claimReliability('2026-09-24T00:01:00.000Z');
    expect(store.recoverReliability('2026-09-24T00:02:00.000Z')).toBe(1);
    expect(store.claimReliability('2026-09-24T00:02:00.000Z')[0]).toMatchObject({ id, status: 'sending', attempts: 2 });
  });

  it('moves failed entries to dead status when requested', () => {
    const store = makeStore();
    const id = store.enqueueReliability({
      channelId: 'feishu', conversationId: 'chat_1', idempotencyKey: 'dead-1',
      payload: { text: 'failed' }, nextAttemptAt: '2026-09-24T00:00:00.000Z',
    });
    store.claimReliability('2026-09-24T00:01:00.000Z');
    store.markReliabilityFailed(id, 'network down', '2026-09-24T00:02:00.000Z', true);
    expect(store.db.prepare('SELECT status, last_error FROM reliability_queue WHERE id = ?').get(id)).toEqual({ status: 'dead', last_error: 'network down' });
  });
});
