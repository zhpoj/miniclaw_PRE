import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SqliteStore } from '../src/storage/sqlite.js';
import { usageLedgerEntryFromAssistantMessage } from '../src/agent/run.js';

const dirs: string[] = [];
const stores: SqliteStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): SqliteStore {
  const dir = mkdtempSync(join(tmpdir(), 'miniclaw-usage-'));
  dirs.push(dir);
  const store = new SqliteStore(join(dir, 'data', 'db', 'messages.db'));
  stores.push(store);
  return store;
}

describe('SqliteStore usage ledger', () => {
  it('normalizes a final assistant message into a metadata-only ledger row', () => {
    expect(usageLedgerEntryFromAssistantMessage('run-9', {
      role: 'assistant', provider: 'deepseek', model: 'deepseek-chat',
      timestamp: 1790244000000,
      usage: { input: 12, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.003 } },
      content: [{ type: 'text', text: 'secret answer' }],
    }, 250)).toEqual({
      runId: 'run-9', provider: 'deepseek', model: 'deepseek-chat',
      inputTokens: 12, outputTokens: 5, cacheTokens: 3,
      estimatedCost: 0.003, latencyMs: 250,
      createdAt: '2026-09-24T10:00:00.000Z',
    });
  });

  it('appends usage rows with nullable token fields', () => {
    const store = makeStore();
    const id = store.appendUsage({
      runId: 'run-1', provider: 'deepseek', model: 'deepseek-v4-pro',
      inputTokens: 120, outputTokens: 40, latencyMs: 900,
      estimatedCost: 0.0012, createdAt: '2026-09-24T10:00:00.000Z',
    });
    expect(store.listUsage()).toMatchObject([{ id, runId: 'run-1' }]);
    expect(store.listUsage()[0]?.cacheTokens).toBeUndefined();
  });

  it('keeps every request and filters totals by model and time range', () => {
    const store = makeStore();
    store.appendUsage({ runId: 'run-1', provider: 'deepseek', model: 'v4', inputTokens: 10, outputTokens: 2, estimatedCost: 1, createdAt: '2026-09-24T10:00:00.000Z' });
    store.appendUsage({ runId: 'run-2', provider: 'deepseek', model: 'v4', inputTokens: 20, outputTokens: 3, estimatedCost: 2, createdAt: '2026-09-25T10:00:00.000Z' });
    store.appendUsage({ runId: 'run-3', provider: 'openai', model: 'o3', inputTokens: 99, outputTokens: 9, estimatedCost: 9, createdAt: '2026-09-24T11:00:00.000Z' });

    const rows = store.listUsage({ model: 'v4', from: '2026-09-24T00:00:00.000Z', to: '2026-09-24T23:59:59.999Z' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputTokens: 10, outputTokens: 2, estimatedCost: 1 });
  });
});
