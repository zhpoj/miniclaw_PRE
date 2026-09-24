import { describe, expect, it } from 'vitest'

import type { AgentEventRecord, ApprovalRecord } from './api'
import { buildConversation } from './conversation'

describe('buildConversation', () => {
  it('turns agent events into readable chat messages and tool activity', () => {
    const events: AgentEventRecord[] = [
      {
        seq: 0,
        at: '2026-09-24T01:00:00.000Z',
        type: 'message_end',
        payload: { message: { role: 'user', content: '检查登录页' } },
      },
      {
        seq: 1,
        at: '2026-09-24T01:00:01.000Z',
        type: 'tool_execution_start',
        payload: { toolCallId: 'tool-1', toolName: 'read', args: {} },
      },
      {
        seq: 2,
        at: '2026-09-24T01:00:02.000Z',
        type: 'tool_execution_end',
        payload: {
          toolCallId: 'tool-1',
          toolName: 'read',
          result: {},
          isError: false,
        },
      },
      {
        seq: 3,
        at: '2026-09-24T01:00:03.000Z',
        type: 'message_end',
        payload: {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '登录页检查完成。' }],
          },
        },
      },
    ]

    expect(buildConversation(events)).toEqual([
      {
        id: 'message-0',
        kind: 'message',
        role: 'user',
        text: '检查登录页',
        at: '2026-09-24T01:00:00.000Z',
      },
      {
        id: 'activity-tool-1',
        kind: 'activity',
        label: '读取项目文件',
        status: 'done',
        at: '2026-09-24T01:00:01.000Z',
      },
      {
        id: 'message-3',
        kind: 'message',
        role: 'assistant',
        text: '登录页检查完成。',
        at: '2026-09-24T01:00:03.000Z',
      },
    ])
  })

  it('updates one approval item across requested, replayed, and resolved events', () => {
    const pending: ApprovalRecord = {
      id: 'approval-1',
      runId: 'run-1',
      turnId: 'turn-1',
      toolName: 'powershell',
      source: 'desktop',
      cwd: 'F:\\project',
      summary: 'npm test',
      details: { command: 'npm test' },
      status: 'pending',
      createdAt: '2026-09-24T01:00:00.000Z',
      expiresAt: '2026-09-24T01:01:00.000Z',
    }
    const allowed = { ...pending, status: 'allowed' as const }
    const events: AgentEventRecord[] = [
      {
        seq: 0,
        at: pending.createdAt,
        type: 'approval_requested',
        payload: { approval: pending },
      },
      {
        seq: 1,
        at: pending.createdAt,
        type: 'approval_requested',
        payload: { approval: pending },
      },
      {
        seq: 2,
        at: '2026-09-24T01:00:02.000Z',
        type: 'approval_resolved',
        payload: { approval: allowed },
      },
    ]

    expect(buildConversation(events)).toEqual([
      {
        id: 'approval-approval-1',
        kind: 'approval',
        approval: allowed,
        at: pending.createdAt,
      },
    ])
  })

  it('merges REST-recovered pending approvals without duplicating SSE items', () => {
    const approval: ApprovalRecord = {
      id: 'approval-2',
      runId: 'run-1',
      turnId: 'turn-1',
      toolName: 'write',
      source: 'feishu',
      cwd: 'F:\\project',
      summary: '写入文件 src/a.ts（5 个字符）',
      details: { path: 'src/a.ts' },
      status: 'pending',
      createdAt: '2026-09-24T01:00:00.000Z',
      expiresAt: '2026-09-24T01:01:00.000Z',
    }
    const events: AgentEventRecord[] = [
      {
        seq: 0,
        at: approval.createdAt,
        type: 'approval_requested',
        payload: { approval },
      },
    ]

    expect(buildConversation(events, [approval])).toEqual([
      {
        id: 'approval-approval-2',
        kind: 'approval',
        approval,
        at: approval.createdAt,
      },
    ])
  })
})
