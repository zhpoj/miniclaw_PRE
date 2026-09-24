import { describe, expect, it } from 'vitest';

import type { ApprovalRecord } from '../src/agent/approval.js';
import { buildApprovalCard } from '../src/im/approval-card.js';

const pendingApproval: ApprovalRecord = {
  id: 'approval-1',
  runId: 'run-1',
  turnId: 'turn-1',
  toolName: 'powershell',
  source: 'feishu',
  principal: { channelId: 'feishu', conversationId: 'oc_1', senderId: 'ou_1' },
  cwd: 'F:\\demo',
  summary: 'npm test',
  details: { command: 'DEEPSEEK_API_KEY=sk-secret-value' },
  status: 'pending',
  createdAt: '2026-09-24T00:00:00.000Z',
  expiresAt: '2026-09-24T00:01:00.000Z',
};

describe('buildApprovalCard', () => {
  it('builds a redacted pending card with exactly three decisions', () => {
    const serialized = JSON.stringify(buildApprovalCard(pendingApproval));

    expect(serialized).toContain('允许一次');
    expect(serialized).toContain('允许本次任务');
    expect(serialized).toContain('拒绝');
    expect(serialized).toContain('approval-1');
    expect(serialized).not.toContain('sk-secret-value');
    expect(serialized.match(/miniclaw_approval/g)).toHaveLength(3);
  });

  it.each([
    ['allowed', '已允许'],
    ['denied', '已拒绝'],
    ['expired', '已过期'],
  ] as const)('renders %s as a final card without actions', (status, label) => {
    const card = buildApprovalCard({ ...pendingApproval, status });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain(label);
    expect(serialized).not.toContain('miniclaw_approval');
  });
});
