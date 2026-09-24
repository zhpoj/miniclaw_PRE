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
  const dir = mkdtempSync(join(tmpdir(), 'miniclaw-scheduled-'));
  dirs.push(dir);
  const store = new SqliteStore(join(dir, 'data', 'db', 'messages.db'));
  stores.push(store);
  return store;
}

describe('SqliteStore scheduled tasks', () => {
  it('returns only enabled due tasks', () => {
    const store = makeStore();
    store.upsertTask({ id: 'due', name: 'due', schedule: 'once', conversationId: 'c1', payload: { text: 'a' }, enabled: true, nextRunAt: '2026-09-24T10:00:00.000Z' });
    store.upsertTask({ id: 'future', name: 'future', schedule: 'once', conversationId: 'c1', payload: {}, enabled: true, nextRunAt: '2026-09-25T10:00:00.000Z' });
    store.upsertTask({ id: 'off', name: 'off', schedule: 'once', conversationId: 'c1', payload: {}, enabled: false, nextRunAt: '2026-09-23T10:00:00.000Z' });
    expect(store.getDueTasks('2026-09-24T12:00:00.000Z').map((task) => task.id)).toEqual(['due']);
  });

  it('allows one claim and records a failed execution', () => {
    const store = makeStore();
    store.upsertTask({ id: 'task-1', name: 'task', schedule: 'once', conversationId: 'c1', payload: { x: 1 }, enabled: true, nextRunAt: '2026-09-24T10:00:00.000Z' });
    const first = store.claimTaskRun('task-1', '2026-09-24T10:01:00.000Z');
    expect(first?.status).toBe('running');
    expect(store.claimTaskRun('task-1', '2026-09-24T10:02:00.000Z')).toBeUndefined();
    store.finishTaskRun(first!.id, { status: 'failed', error: 'network down' });
    expect(store.getTaskRuns('task-1')[0]).toMatchObject({ status: 'failed', error: 'network down' });
  });
});
