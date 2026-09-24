import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApprovalError,
  ApprovalManager,
  summarizeToolCall,
  type ApprovalRequestInput,
} from '../src/agent/approval.js';

const baseRequest: ApprovalRequestInput = {
  runId: 'run-1',
  turnId: 'turn-1',
  source: 'desktop',
  cwd: 'F:\\project',
  toolName: 'write',
  input: { path: 'src/a.ts', content: 'hello' },
};

function readyManager(now = () => 1_000): ApprovalManager {
  const manager = new ApprovalManager({ now, timeoutMs: 30_000, clientTtlMs: 10_000 });
  manager.heartbeat('desktop-1');
  manager.beginTurn('run-1', 'turn-1', 'desktop');
  return manager;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ApprovalManager', () => {
  it('keeps a dangerous tool pending until it is allowed once', async () => {
    const manager = readyManager();

    const outcome = manager.request(baseRequest);
    const [record] = manager.listPending('run-1');

    expect(record).toMatchObject({
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'pending',
      summary: '写入文件 src/a.ts（5 个字符）',
    });
    manager.decide(record!.id, 'allow_once');

    await expect(outcome).resolves.toEqual({ allowed: true, scope: 'once' });
    expect(manager.listPending('run-1')).toEqual([]);
  });

  it('allows every pending and later dangerous call in the same turn', async () => {
    const manager = readyManager();
    const first = manager.request(baseRequest);
    const second = manager.request({
      ...baseRequest,
      toolName: 'edit',
      input: { path: 'src/b.ts', oldText: 'a', newText: 'b' },
    });
    const [record] = manager.listPending('run-1');

    manager.decide(record!.id, 'allow_turn');

    await expect(first).resolves.toEqual({ allowed: true, scope: 'turn' });
    await expect(second).resolves.toEqual({ allowed: true, scope: 'turn' });
    await expect(
      manager.request({ ...baseRequest, toolName: 'powershell', input: { command: 'npm test' } }),
    ).resolves.toEqual({ allowed: true, scope: 'turn' });
  });

  it('denies one call without granting the rest of the turn', async () => {
    const manager = readyManager();
    const outcome = manager.request(baseRequest);
    const [record] = manager.listPending();

    manager.decide(record!.id, 'deny');

    await expect(outcome).resolves.toEqual({ allowed: false, reason: '用户拒绝了此操作' });
    void manager.request({ ...baseRequest, toolName: 'edit' });
    expect(manager.listPending()).toHaveLength(1);
    manager.endTurn('run-1', 'test cleanup');
  });

  it('fails closed when no desktop approval client is active', async () => {
    const manager = new ApprovalManager({ now: () => 1_000 });
    manager.beginTurn('run-1', 'turn-1', 'feishu');

    await expect(manager.request({ ...baseRequest, source: 'feishu' })).resolves.toEqual({
      allowed: false,
      reason: '需要在桌面客户端确认此操作',
    });
    expect(manager.listPending()).toEqual([]);
  });

  it('expires a pending operation and rejects a late decision', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const manager = readyManager(() => now);
    const outcome = manager.request(baseRequest);
    const [record] = manager.listPending();

    now += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(outcome).resolves.toEqual({ allowed: false, reason: '操作确认已超时' });
    expect(() => manager.decide(record!.id, 'allow_once')).toThrowError(
      expect.objectContaining<Partial<ApprovalError>>({ code: 'approval_not_pending', status: 409 }),
    );
  });

  it('expires desktop presence at the client TTL boundary', () => {
    let now = 1_000;
    const manager = readyManager(() => now);

    now = 10_999;
    expect(manager.hasActiveClient()).toBe(true);
    now = 11_000;
    expect(manager.hasActiveClient()).toBe(false);
  });

  it('cancels pending calls and clears a turn grant when the turn ends', async () => {
    const manager = readyManager();
    const pending = manager.request(baseRequest);

    manager.endTurn('run-1', 'run aborted');

    await expect(pending).resolves.toEqual({ allowed: false, reason: 'run aborted' });
    manager.beginTurn('run-1', 'turn-2', 'desktop');
    void manager.request({ ...baseRequest, turnId: 'turn-2' });
    expect(manager.listPending('run-1')).toHaveLength(1);
    manager.endTurn('run-1', 'test cleanup');
  });

  it('returns approval events without exposing command secrets', async () => {
    const manager = readyManager();
    const events: unknown[] = [];
    manager.subscribe((event) => events.push(event));

    const outcome = manager.request({
      ...baseRequest,
      toolName: 'powershell',
      input: {
        command: '$env:DEEPSEEK_API_KEY="sk-secret-value"; npm test',
      },
    });
    const [record] = manager.listPending();

    expect(JSON.stringify(record)).not.toContain('sk-secret-value');
    expect(JSON.stringify(events)).not.toContain('sk-secret-value');
    expect(record?.summary).toContain('[REDACTED]');
    manager.decide(record!.id, 'deny');
    await outcome;
  });

  it('summarizes normalized paths and truncates long previews', () => {
    const summary = summarizeToolCall('edit', {
      file_path: 'src/large.ts',
      oldText: 'a'.repeat(2_100),
      newText: 'replacement',
    }, 'F:\\project');

    expect(summary.summary).toBe('修改文件 src/large.ts');
    expect(String(summary.details.oldText)).toHaveLength(2_001);
    expect(String(summary.details.oldText)).toMatch(/…$/);
    expect(summary.details.cwd).toBe('F:\\project');
  });
});
