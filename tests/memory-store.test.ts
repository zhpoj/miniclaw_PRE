import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/storage/sqlite.js';

const dirs: string[] = []; const stores: SqliteStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function makeStore(): SqliteStore { const d = mkdtempSync(join(tmpdir(), 'miniclaw-memory-')); dirs.push(d); const s = new SqliteStore(join(d, 'data', 'db', 'messages.db')); stores.push(s); return s; }

describe('SqliteStore memory', () => {
  it('isolates scope, searches keywords, touches and soft deletes', () => {
    const store = makeStore();
    const global = store.insertMemory({ scope: 'global', scopeId: 'global', content: 'always use TypeScript', source: 'user', importance: 0.8 });
    store.insertMemory({ scope: 'conversation', scopeId: 'c1', content: 'deploy to staging', source: 'chat', importance: 0.5 });
    store.insertMemory({ scope: 'conversation', scopeId: 'c2', content: 'deploy to production', source: 'chat', importance: 0.5 });
    expect(store.searchMemories('conversation', 'c1', 'deploy')).toHaveLength(1);
    expect(store.searchMemories('conversation', 'c1', 'production')).toHaveLength(0);
    store.touchMemory(global);
    store.softDeleteMemory(global);
    expect(store.searchMemories('global', 'global', 'TypeScript')).toHaveLength(0);
  });
});
