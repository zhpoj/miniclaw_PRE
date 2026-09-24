import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import {
  ApprovalManager,
  type FeishuApprovalPrincipal,
} from '../src/agent/approval.js';
import {
  AgentTurnApprovals,
  createApprovalExtension,
} from '../src/agent/run.js';

type ToolCallHandler = (
  event: ToolCallEvent,
  context: unknown,
) => Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined;

function installGate(options: {
  approvals: ApprovalManager;
  turn?: {
    id: string;
    source: 'desktop' | 'web' | 'feishu';
    principal?: FeishuApprovalPrincipal;
  };
}): ToolCallHandler {
  let handler: ToolCallHandler | undefined;
  const api = {
    on(event: string, candidate: ToolCallHandler) {
      if (event === 'tool_call') handler = candidate;
      return () => undefined;
    },
  } as unknown as ExtensionAPI;

  createApprovalExtension({
    approvals: options.approvals,
    runId: 'run-1',
    cwd: 'F:\\project',
    getTurn: () => options.turn,
  })(api);

  if (!handler) throw new Error('tool_call handler was not registered');
  return handler;
}

function event(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { type: 'tool_call', toolName, input, toolCallId: 'tool-1' } as ToolCallEvent;
}

describe('createApprovalExtension', () => {
  it('lets read and unspecified bash calls pass without approval', async () => {
    const approvals = new ApprovalManager();
    const call = installGate({
      approvals,
      turn: { id: 'turn-1', source: 'desktop' },
    });

    await expect(call(event('read', { path: 'a.ts' }), {})).resolves.toBeUndefined();
    await expect(call(event('bash', { command: 'npm test' }), {})).resolves.toBeUndefined();
    expect(approvals.listPending()).toEqual([]);
  });

  it('blocks a dangerous call when no desktop approval client is active', async () => {
    const approvals = new ApprovalManager();
    approvals.beginTurn('run-1', 'turn-1', 'desktop');
    const call = installGate({
      approvals,
      turn: { id: 'turn-1', source: 'desktop' },
    });

    await expect(
      call(event('write', { path: 'a.ts', content: 'x' }), {}),
    ).resolves.toEqual({
      block: true,
      reason: '需要在桌面客户端确认此操作',
    });
  });

  it('continues after one-time approval and blocks after denial', async () => {
    const approvals = new ApprovalManager({ now: () => 1_000 });
    approvals.heartbeat('desktop-1');
    approvals.beginTurn('run-1', 'turn-1', 'desktop');
    const call = installGate({
      approvals,
      turn: { id: 'turn-1', source: 'desktop' },
    });

    const allowed = call(event('edit', { path: 'a.ts' }), {});
    approvals.decide(approvals.listPending()[0]!.id, 'allow_once');
    await expect(allowed).resolves.toBeUndefined();

    const denied = call(event('powershell', { command: 'npm test' }), {});
    approvals.decide(approvals.listPending()[0]!.id, 'deny');
    await expect(denied).resolves.toEqual({ block: true, reason: '用户拒绝了此操作' });
  });

  it('passes the Feishu principal from the active turn into the approval request', async () => {
    const approvals = new ApprovalManager({ now: () => 1_000 });
    const principal = {
      channelId: 'feishu' as const,
      conversationId: 'oc_chat_1',
      senderId: 'ou_owner',
    };
    approvals.beginTurn('run-1', 'turn-1', 'feishu');
    const call = installGate({
      approvals,
      turn: { id: 'turn-1', source: 'feishu', principal },
    });

    const pending = call(event('powershell', { command: 'npm test' }), {});

    expect(approvals.listPending()[0]?.principal).toEqual(principal);
    approvals.decideFromFeishu({
      id: approvals.listPending()[0]!.id,
      actorId: 'ou_owner',
      decision: 'allow_once',
    });
    await expect(pending).resolves.toBeUndefined();
  });

  it('fails closed when there is no active turn', async () => {
    const approvals = new ApprovalManager();
    const call = installGate({ approvals });

    await expect(call(event('write', { path: 'a.ts', content: 'x' }), {})).resolves.toEqual({
      block: true,
      reason: '当前没有可授权的任务',
    });
  });

  it('fails closed when the approval manager throws', async () => {
    const approvals = {
      request: vi.fn().mockRejectedValue(new Error('approval store failed')),
    } as unknown as ApprovalManager;
    const call = installGate({
      approvals,
      turn: { id: 'turn-1', source: 'desktop' },
    });

    await expect(call(event('write', { path: 'a.ts', content: 'x' }), {})).resolves.toEqual({
      block: true,
      reason: '操作审批服务异常，已阻止执行',
    });
  });
});

describe('AgentTurnApprovals', () => {
  it('does not carry a Feishu turn grant into a queued follow-up', async () => {
    const approvals = new ApprovalManager({ now: () => 1_000 });
    const principal = {
      channelId: 'feishu' as const,
      conversationId: 'oc_chat_1',
      senderId: 'ou_owner',
    };
    const turns = new AgentTurnApprovals(approvals, 'run-1');
    turns.start({ source: 'feishu', principal });
    expect(turns.current()?.principal).toEqual(principal);

    const first = approvals.request({
      runId: 'run-1',
      turnId: turns.current()!.id,
      source: 'feishu',
      principal,
      cwd: 'F:\\project',
      toolName: 'write',
      input: { path: 'a.ts', content: 'x' },
    });
    approvals.decideFromFeishu({
      id: approvals.listPending()[0]!.id,
      actorId: 'ou_owner',
      decision: 'allow_turn',
    });
    await expect(first).resolves.toEqual({ allowed: true, scope: 'turn' });

    turns.onTurnStart();
    turns.queue({ source: 'feishu', principal });
    turns.onTurnStart();
    expect(turns.current()?.principal).toEqual(principal);
    const second = approvals.request({
      runId: 'run-1',
      turnId: turns.current()!.id,
      source: 'feishu',
      principal,
      cwd: 'F:\\project',
      toolName: 'write',
      input: { path: 'b.ts', content: 'y' },
    });

    expect(approvals.listPending()).toHaveLength(1);
    approvals.decideFromFeishu({
      id: approvals.listPending()[0]!.id,
      actorId: 'ou_owner',
      decision: 'deny',
    });
    await expect(second).resolves.toEqual({ allowed: false, reason: '用户拒绝了此操作' });
  });

  it('expires a turn grant before a queued follow-up starts', async () => {
    const approvals = new ApprovalManager({ now: () => 1_000 });
    approvals.heartbeat('desktop-1');
    const turns = new AgentTurnApprovals(approvals, 'run-1');
    turns.start({ source: 'desktop' });

    const first = approvals.request({
      runId: 'run-1',
      turnId: turns.current()!.id,
      source: 'desktop',
      cwd: 'F:\\project',
      toolName: 'write',
      input: { path: 'a.ts', content: 'x' },
    });
    approvals.decide(approvals.listPending()[0]!.id, 'allow_turn');
    await expect(first).resolves.toEqual({ allowed: true, scope: 'turn' });

    turns.onTurnStart();
    turns.queue({ source: 'desktop' });
    turns.onTurnStart();
    const second = approvals.request({
      runId: 'run-1',
      turnId: turns.current()!.id,
      source: 'desktop',
      cwd: 'F:\\project',
      toolName: 'write',
      input: { path: 'b.ts', content: 'y' },
    });

    expect(approvals.listPending()).toHaveLength(1);
    approvals.decide(approvals.listPending()[0]!.id, 'deny');
    await expect(second).resolves.toEqual({ allowed: false, reason: '用户拒绝了此操作' });
  });
});
