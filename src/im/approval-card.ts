import type { ApprovalRecord } from '../agent/approval.js';

type ApprovalCardState = ApprovalRecord['status'];

const FINAL_STATE: Record<Exclude<ApprovalCardState, 'pending'>, { label: string; template: string }> = {
  allowed: { label: '已允许', template: 'green' },
  denied: { label: '已拒绝', template: 'red' },
  expired: { label: '已过期', template: 'grey' },
  cancelled: { label: '已取消', template: 'grey' },
};

/**
 * Builds a Feishu approval card from the already-sanitized approval record.
 * Deliberately never renders `details`, which may contain command or file data.
 */
export function buildApprovalCard(
  record: ApprovalRecord,
  state: ApprovalCardState = record.status,
): Record<string, unknown> {
  const final = state === 'pending' ? undefined : FINAL_STATE[state];
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: `**${record.toolName}** 需要你的确认\n\n${record.summary}\n\n工作目录：${record.cwd}` },
  ];

  if (final) {
    elements.push({ tag: 'markdown', content: `审批结果：${final.label}` });
  } else {
    elements.push({
      tag: 'action',
      actions: [
        button(record.id, 'allow_once', '允许一次', 'primary'),
        button(record.id, 'allow_turn', '允许本次任务', 'default'),
        button(record.id, 'deny', '拒绝', 'danger'),
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: final ? 'MiniClaw 审批结果' : 'MiniClaw 操作审批' },
      template: final?.template ?? 'orange',
    },
    elements,
  };
}

function button(
  approvalId: string,
  decision: 'allow_once' | 'allow_turn' | 'deny',
  text: string,
  type: 'primary' | 'default' | 'danger',
): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    value: { kind: 'miniclaw_approval', approvalId, decision },
  };
}
