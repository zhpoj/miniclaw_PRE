# 飞书远程审批卡片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让飞书任务的原发起人能通过交互式卡片批准或拒绝本机危险操作。

**Architecture:** ApprovalManager 保留唯一的授权状态，并为飞书审批记录保存不可变的发起人身份。AgentRun 将飞书消息的主体传递到当前 turn；FeishuChannel 把 `card.action.trigger` 归一化为受限动作；IMBridge 在同一会话发送、更新卡片，并把回调交给 ApprovalManager 重新校验。

**Tech Stack:** TypeScript、Vitest、Hono、Electron、`@larksuiteoapi/node-sdk` WebSocket EventDispatcher、飞书 interactive message cards。

**Spec:** `docs/superpowers/specs/2026-09-24-feishu-approval-cards-design.md`

## Global Constraints

- 仅 `edit`、`write`、`powershell` 需要审批；`read` 继续直接执行。
- 只有原飞书任务发起人的 `open_id` 能批准或拒绝。
- 保留已有 60 秒过期、允许一次、允许本次任务、拒绝和任务结束时撤销授权的语义。
- 卡片、日志和审批记录不得包含 API Key、Token、Secret、Password 或完整超长内容。
- 卡片回调不得直接执行客户端传来的命令；它只能引用服务端已有的审批 UUID。
- 卡片发送失败、未知/过期/重复回调、身份不符、任务中止和应用退出都必须默认拒绝。
- 继续使用飞书长连接；不引入公网回调地址或内网穿透。
- 保持桌面/Web 现有审批 API 与界面行为不变。

## Review Focus

- 群聊中的非任务发起人点击“允许”时，卡片和 Agent 状态均不得改变；Task 1 测试。
- 已过期、已拒绝或已被处理的卡片重复投递回调时，不得重新授权；Task 1 测试。
- 飞书回调缺少 `open_id`、审批 UUID 或决策值不在白名单时，不得调用 ApprovalManager；Task 3 测试。
- 审批卡片发送或结果更新失败时，待审批工具调用必须被拒绝而不是无限等待；Task 4 测试。
- “允许本次任务”不得跨越 follow-up/新 turn；Task 2 测试。

---

## File Structure

- `src/agent/approval.ts`：审批主体、飞书决策校验和既有审批状态机。
- `src/agent/run.ts`：把 prompt 来源与审批主体固定到 active/queued turn，再交给工具门禁。
- `src/im/IMChannel.ts`：可选的、传输无关的卡片动作契约。
- `src/im/feishu.ts`：`card.action.trigger` 的 WebSocket 注册、解析和动作分发。
- `src/im/approval-card.ts`：纯函数构造 pending/final 飞书审批卡片。
- `src/im/bridge.ts`：把飞书消息身份交给 run，发送/更新卡片，路由点击结果。
- `tests/approval.test.ts`：远程主体和决策状态机。
- `tests/agent-approval.test.ts`：turn 身份传播与跨 turn 授权边界。
- `tests/im.test.ts`：飞书长连接中的卡片动作归一化。
- `tests/im-bridge.test.ts`：任务到卡片、点击到授权、失败默认拒绝的集成测试。
- `飞书机器人真实接入操作记录.md`：开发者后台订阅和真实验证步骤。

### Task 1: 为审批状态机增加飞书身份校验

**Files:**
- Modify: `src/agent/approval.ts`
- Modify: `tests/approval.test.ts`

**Interfaces:**
- Produces: `export interface FeishuApprovalPrincipal { readonly channelId: 'feishu'; readonly conversationId: string; readonly senderId: string }`。
- Produces: `ApprovalRequestInput.principal?: FeishuApprovalPrincipal` 与 `ApprovalRecord.principal?: FeishuApprovalPrincipal`。
- Produces: `ApprovalManager.decideFromFeishu(input: { id: string; actorId: string; decision: ApprovalDecision }): ApprovalRecord`。
- Consumes: 现有 `ApprovalDecision`、`request()`、`decide()` 和 pending 状态机。

- [ ] **Step 1: 写入远程身份和重复回调的失败测试**

在 `tests/approval.test.ts` 添加辅助对象与用例：

```ts
const feishuPrincipal = {
  channelId: 'feishu' as const,
  conversationId: 'oc_chat_1',
  senderId: 'ou_owner',
};

it('allows only the original Feishu sender to approve a pending operation', async () => {
  const manager = new ApprovalManager({ now: () => 1_000 });
  manager.beginTurn('run-1', 'turn-1', 'feishu');
  const outcome = manager.request({ ...baseRequest, source: 'feishu', principal: feishuPrincipal });
  const [record] = manager.listPending();

  expect(() => manager.decideFromFeishu({
    id: record!.id, actorId: 'ou_other', decision: 'allow_once',
  })).toThrow(/not authorized/i);
  manager.decideFromFeishu({ id: record!.id, actorId: 'ou_owner', decision: 'allow_once' });

  await expect(outcome).resolves.toEqual({ allowed: true, scope: 'once' });
});

it('rejects a second Feishu callback after the approval is resolved', () => {
  // Create a pending Feishu approval, decide it once, then assert the second
  // call throws ApprovalError { code: 'approval_not_pending', status: 409 }.
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test -- tests/approval.test.ts`

Expected: FAIL，原因是 `principal` 和 `decideFromFeishu` 尚不存在。

- [ ] **Step 3: 实现最小的主体与决策校验**

在 `approval.ts`：

```ts
export interface FeishuApprovalPrincipal {
  readonly channelId: 'feishu';
  readonly conversationId: string;
  readonly senderId: string;
}

decideFromFeishu(input: {
  id: string;
  actorId: string;
  decision: ApprovalDecision;
}): ApprovalRecord {
  const record = this.records.get(input.id);
  if (!record) throw new ApprovalError('approval_not_found', 'Unknown approval request.', 404);
  if (record.source !== 'feishu' || !record.principal || record.principal.senderId !== input.actorId) {
    throw new ApprovalError('approval_not_authorized', 'Actor is not allowed to decide this approval.', 403);
  }
  return this.decide(input.id, input.decision);
}
```

增加 `approval_not_authorized` 到 `ApprovalError` 的 code/status 联合类型；在 `request()` 中，`source === 'feishu'` 时要求有效 principal、但不要求桌面 heartbeat。桌面/Web 请求仍维持已有 heartbeat 检查。

- [ ] **Step 4: 补齐失败关闭和脱敏断言**

添加测试，确保没有 principal 的飞书危险请求返回 `{ allowed: false, reason: '远程审批缺少发起人身份' }` 且不留下 pending 记录；确认 `JSON.stringify(record)` 不包含敏感命令内容。

- [ ] **Step 5: 运行测试并确认通过**

Run: `npm test -- tests/approval.test.ts`

Expected: PASS，包含原有桌面审批回归和新增的主体、过期、重复回调覆盖。

- [ ] **Step 6: 提交 Task 1**

```bash
git add src/agent/approval.ts tests/approval.test.ts
git commit -m "feat: authorize Feishu approval principals"
```

### Task 2: 将飞书审批主体固定到 Agent turn

**Files:**
- Modify: `src/agent/run.ts`
- Modify: `tests/agent-approval.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `FeishuApprovalPrincipal`。
- Produces: `PromptOptions.principal?: FeishuApprovalPrincipal`。
- Produces: `ActiveTurn` 与 `QueuedTurn` 同时保存 `source` 和 `principal`。
- Produces: `AgentTurnApprovals.start(options)`、`queue(options)`、`onTurnStart()` 保留同一 turn 的身份且在 follow-up 新 turn 清除旧授权。

- [ ] **Step 1: 写入主体经工具门禁传递的失败测试**

修改 `installGate()` 让它能传入 `principal`，添加：

```ts
it('passes the Feishu principal from the active turn into the approval request', async () => {
  const approvals = new ApprovalManager({ now: () => 1_000 });
  approvals.beginTurn('run-1', 'turn-1', 'feishu');
  const call = installGate({
    approvals,
    turn: {
      id: 'turn-1', source: 'feishu',
      principal: { channelId: 'feishu', conversationId: 'oc_chat_1', senderId: 'ou_owner' },
    },
  });

  const pending = call(event('powershell', { command: 'npm test' }), {});
  expect(approvals.listPending()[0]?.principal?.senderId).toBe('ou_owner');
  approvals.decideFromFeishu({
    id: approvals.listPending()[0]!.id, actorId: 'ou_owner', decision: 'allow_once',
  });
  await expect(pending).resolves.toBeUndefined();
});
```

添加 follow-up 用例：第一 turn 的 `allow_turn` 后，`turns.queue({ source: 'feishu', principal })` 和下一次 `onTurnStart()` 创建新 turn；新危险调用必须再次 pending。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test -- tests/agent-approval.test.ts`

Expected: FAIL，原因是 active turn 未定义 `principal`。

- [ ] **Step 3: 实现 turn 上下文传播**

将 `PromptOptions` 改为：

```ts
export interface PromptOptions {
  streamingBehavior?: 'steer' | 'followUp';
  source?: PromptSource;
  principal?: FeishuApprovalPrincipal;
}
```

将 `ActiveTurn`、`QueuedTurn` 和 `AgentTurnApprovals` 的 `start/queue/replace` 参数改为 `{ source, principal }`；`createApprovalExtension()` 调用 `approvals.request()` 时传入 `turn.principal`。仅接受 `source === 'feishu'` 的 principal，desktop/web 的 principal 忽略。

- [ ] **Step 4: 运行测试并确认通过**

Run: `npm test -- tests/agent-approval.test.ts`

Expected: PASS，读操作仍不审批，危险操作带主体，整轮授权不跨 follow-up。

- [ ] **Step 5: 提交 Task 2**

```bash
git add src/agent/run.ts tests/agent-approval.test.ts
git commit -m "feat: bind Feishu identity to agent turns"
```

### Task 3: 归一化飞书交互卡片回调

**Files:**
- Modify: `src/im/IMChannel.ts`
- Modify: `src/im/feishu.ts`
- Modify: `tests/im.test.ts`

**Interfaces:**
- Produces: `export interface CardAction { readonly channelId: string; readonly actorId: string; readonly approvalId: string; readonly decision: 'allow_once' | 'allow_turn' | 'deny' }`。
- Produces: optional `IMChannel.onCardAction?(handler: CardActionHandler): () => void`，使既有非交互 channel 不需要修改。
- Produces: `FeishuChannel.onCardAction(handler)`；只发出已验证形状的 MiniClaw 审批动作。
- Consumes: 飞书 `card.action.trigger` 的 `open_id` 和 `action.value`；Task 1 的决策联合类型。

- [ ] **Step 1: 写入卡片回调归一化的失败测试**

在 `tests/im.test.ts` 添加假 transport，分别把以下事件送入 `start()` 的 handler：

```ts
{
  open_id: 'ou_owner',
  open_message_id: 'om_card_1',
  action: { value: { kind: 'miniclaw_approval', approvalId: 'uuid-1', decision: 'allow_once' } },
}
```

断言 `onCardAction()` 收到 `{ channelId: 'feishu', actorId: 'ou_owner', approvalId: 'uuid-1', decision: 'allow_once' }`。再写三个用例：缺失 `open_id`、未知 `kind`、`decision: 'delete_everything'` 都不触发 handler。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test -- tests/im.test.ts`

Expected: FAIL，原因是 transport 只接受消息事件、FeishuChannel 没有 `onCardAction()`。

- [ ] **Step 3: 扩展 transport 与 FeishuChannel**

定义：

```ts
export interface FeishuEventHandlers {
  onMessage(event: Record<string, unknown>): Promise<void>;
  onCardAction(event: Record<string, unknown>): Promise<void>;
}

export interface FeishuEventTransport {
  start(handlers: FeishuEventHandlers): Promise<void>;
  stop(): Promise<void>;
}
```

在 `createLarkTransport()` 的 `EventDispatcher.register()` 同时注册 `im.message.receive_v1` 和 `card.action.trigger`。新增私有 `toCardAction()`：仅当 `action.value.kind === 'miniclaw_approval'`、`approvalId` 为非空字符串、`decision` 是三个白名单值之一、`open_id` 为非空字符串时返回动作。用独立 `Set<CardActionHandler>` 分发，单个 handler 出错只记录错误，不影响其他 handler 或长连接。

- [ ] **Step 4: 运行测试并确认通过**

Run: `npm test -- tests/im.test.ts`

Expected: PASS，消息长连接回归不变，合法卡片动作被归一化，畸形动作无副作用。

- [ ] **Step 5: 提交 Task 3**

```bash
git add src/im/IMChannel.ts src/im/feishu.ts tests/im.test.ts
git commit -m "feat: receive Feishu approval card actions"
```

### Task 4: 发送、决策和更新飞书审批卡片

**Files:**
- Create: `src/im/approval-card.ts`
- Modify: `src/im/bridge.ts`
- Modify: `tests/im-bridge.test.ts`
- Test: `tests/im-approval-card.test.ts`

**Interfaces:**
- Consumes: Task 1 `ApprovalRecord` / `decideFromFeishu()`，Task 2 `PromptOptions.principal`，Task 3 `CardAction` / `onCardAction()`。
- Produces: `buildApprovalCard(record: ApprovalRecord, state?: ApprovalCardState): Record<string, unknown>`。
- Produces: IMBridge 在 attach 时注册审批事件和可选卡片动作 handler，并在 dispose 时取消全部订阅。

- [ ] **Step 1: 写入纯卡片构造的失败测试**

创建 `tests/im-approval-card.test.ts`：

```ts
it('builds a redacted pending card with exactly three decisions', () => {
  const card = buildApprovalCard({
    id: 'approval-1', runId: 'run-1', turnId: 'turn-1',
    source: 'feishu', toolName: 'powershell', summary: 'npm test',
    cwd: 'F:\\demo', status: 'pending',
    details: { command: 'npm test', cwd: 'F:\\demo' },
    createdAt: '2026-09-24T00:00:00.000Z',
    expiresAt: '2026-09-24T00:01:00.000Z',
    principal: { channelId: 'feishu', conversationId: 'oc_1', senderId: 'ou_1' },
  });
  expect(JSON.stringify(card)).toContain('允许一次');
  expect(JSON.stringify(card)).toContain('允许本次任务');
  expect(JSON.stringify(card)).toContain('拒绝');
  expect(JSON.stringify(card)).toContain('approval-1');
  expect(JSON.stringify(card)).not.toContain('sk-');
});
```

再写 final-state 用例，断言 `allowed` / `denied` / `expired` 卡片没有 `actions`，并显示相应终态文字。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test -- tests/im-approval-card.test.ts`

Expected: FAIL，原因是 `src/im/approval-card.ts` 不存在。

- [ ] **Step 3: 实现安全的卡片构造器**

`buildApprovalCard()` 使用已有 `record.summary` 和 `record.cwd`，不读取原始工具输入。pending 卡片的每个 button 设置：

```ts
value: { kind: 'miniclaw_approval', approvalId: record.id, decision: 'allow_once' }
```

final 卡片使用禁用按钮或不含 actions 的静态文本。卡片头部 pending 使用 `orange`，allowed 使用 `green`，denied/expired 使用 `red`/`grey`。

- [ ] **Step 4: 写入 bridge 端到端失败测试**

在 `tests/im-bridge.test.ts` 的 fake channel 增加可选 `onCardAction()`、`emitCardAction()`、`sentCards` 和 `updatedCards`。测试：

```ts
it('sends a Feishu approval card and lets only its sender allow once', async () => {
  // Ingest a message from ou_owner, have the fake run request a dangerous tool,
  // assert one card is sent, then emit ou_other and assert it stays pending.
  // Emit ou_owner/allow_once and assert the tool call resolves and the card updates.
});

it('denies the pending operation when card delivery fails', async () => {
  // Make fakeChannel.send reject; assert the recorded tool_call is blocked
  // with a denial reason instead of hanging until timeout.
});
```

另加过期更新、`allow_turn` 同 turn 放行、`dispose()` 后卡片动作无效的测试。

- [ ] **Step 5: 运行 bridge 测试并确认失败**

Run: `npm test -- tests/im-bridge.test.ts tests/im-approval-card.test.ts`

Expected: FAIL，原因是 bridge 还没有审批事件订阅和卡片路由。

- [ ] **Step 6: 实现 IMBridge 路由**

扩展 `IMBridgeEngine` 为：

```ts
type IMBridgeEngine = Pick<AgentEngine, 'createRun' | 'getApprovalManager'>;
```

`runTurn()` 调用：

```ts
await run.prompt(message.text, {
  source: 'feishu',
  principal: {
    channelId: message.channelId,
    conversationId: message.conversationId,
    senderId: message.senderId,
  },
});
```

构造函数订阅 `engine.getApprovalManager()`。当事件为 `approval_requested` 且 record 的 principal 指向已附加 channel 时，用 `channel.send(conversationId, { card: buildApprovalCard(record) })` 发送，保存 `{ channel, messageId }`。若发送失败，调用既有 `decide(record.id, 'deny')`，使工具调用立即 fail closed。

当可选 `onCardAction` 收到动作时，调用 `decideFromFeishu()`；成功或终态事件发生时，使用保存的 `messageId` 调用 `channel.update(messageId, { card: buildApprovalCard(record) })`。未授权、未知或已处理动作只记录安全日志，绝不更新卡片或执行工具。`dispose()` 取消 ApprovalManager 和 card-action 的订阅并清空卡片映射。

- [ ] **Step 7: 运行 bridge 与全套后端测试**

Run: `npm test -- tests/im-bridge.test.ts tests/im-approval-card.test.ts && npm test`

Expected: PASS，审批卡片在发起、允许、拒绝、过期和发送失败路径均可预测，所有现有测试继续通过。

- [ ] **Step 8: 提交 Task 4**

```bash
git add src/im/approval-card.ts src/im/bridge.ts tests/im-bridge.test.ts tests/im-approval-card.test.ts
git commit -m "feat: route Feishu approval cards"
```

### Task 5: 完成配置说明与真实飞书验收

**Files:**
- Modify: `飞书机器人真实接入操作记录.md`
- Modify: `日志.md`

**Interfaces:**
- Consumes: Task 3 的 `card.action.trigger` 订阅与 Task 4 的审批卡片。
- Produces: 可由用户重复执行的飞书后台配置、手机审批和故障排查步骤。

- [ ] **Step 1: 写入文档变更前的验收清单**

在操作记录中预先列出以下必须验证的条目：开发者后台添加 `card.action.trigger`、发布版本、手机端触发 `powershell` 操作、允许一次、拒绝、非发起人拒绝和 60 秒过期。

- [ ] **Step 2: 运行静态验证**

Run: `npm run typecheck && npm run build && npm --prefix web run lint && npm --prefix web run build`

Expected: 所有命令 exit 0。

- [ ] **Step 3: 在飞书开发者后台完成用户侧配置**

在“事件与回调”中新增 `card.action.trigger` 卡片回调，保留已有 `im.message.receive_v1` 长连接订阅；创建并发布新版本。此步骤需要用户已登录的飞书开发者后台，不能由代码替代。

- [ ] **Step 4: 真实端到端验收**

启动 `npm run desktop:dev`，从飞书向机器人发送会触发危险工具的明确任务。确认机器人发出卡片；以原发起账号完成一次“允许一次”和一次“拒绝”；在群聊中由另一账号点击同类卡片，确认无执行；等待一张卡片超过 60 秒，确认其更新为过期且操作未执行。

- [ ] **Step 5: 写入最终操作记录**

更新 `飞书机器人真实接入操作记录.md` 与 `日志.md`，记录后台订阅名称、实际验收结果、限制（电脑和 MiniClaw 必须在线）与安全建议；不得写入真实 App Secret 或 API Key。

- [ ] **Step 6: 提交 Task 5**

```bash
git add "飞书机器人真实接入操作记录.md" "日志.md"
git commit -m "docs: record Feishu approval card setup"
```
