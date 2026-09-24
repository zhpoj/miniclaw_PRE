# 飞书远程操作审批卡片：设计

日期：2026-09-24

## 目标

让用户能够在飞书中批准或拒绝 MiniClaw 的危险本机操作。危险操作包括修改文件、写入文件和执行 PowerShell 命令；只读分析仍可直接完成。

用户在飞书发送任务后，若 Agent 需要危险操作，机器人应在同一会话发送交互式审批卡片。仅发起该任务的飞书账号可选择：

- 允许一次：仅放行当前这一条工具调用。
- 允许本次任务：放行该任务余下的危险工具调用；任务结束后自动失效。
- 拒绝：不执行当前操作。

## 非目标

- 不提供 TeamViewer 式屏幕、鼠标或键盘远程控制。
- 不让群内其他成员、陌生账号或任意文本命令取得审批权。
- 不让授权跨任务、跨会话或跨应用重启永久保留。
- 不改变桌面端和 Web 端现有的审批界面。

## 用户体验

卡片展示脱敏后的操作摘要、工作目录、操作类型和 60 秒有效期。例如：

```text
MiniClaw 请求执行操作
类型：PowerShell
内容：npm test
工作目录：F:\\Projects\\demo
有效期：60 秒

[允许一次] [允许本次任务] [拒绝]
```

点击后，卡片更新为“已允许一次”“已允许本次任务”“已拒绝”或“已过期”，并禁用按钮。卡片无法发送、回调无效或身份不匹配时，危险操作一律不执行。

## 架构与数据流

```text
飞书任务消息（senderId）
  -> IMBridge 创建/复用该会话的 Agent Run
  -> Agent 请求 edit/write/powershell
  -> ApprovalManager 创建绑定 senderId 的待审批记录
  -> IMBridge 在原飞书会话发送审批卡片
  -> 用户点击卡片
  -> 飞书 card.action.trigger 经 WebSocket 到 FeishuChannel
  -> 身份、审批状态、有效期、来源校验
  -> ApprovalManager 允许或拒绝
  -> Agent 继续或停止该工具调用；卡片更新结果
```

### 审批主体

为每个来自飞书的危险操作记录不可变的审批主体：

```ts
{
  channelId: 'feishu',
  conversationId: string,
  senderId: string,
}
```

审批回调中的飞书 `open_id` 必须与 `senderId` 精确一致。审批卡片中的数据只携带随机 UUID 审批 ID 和固定的决策值，不携带命令、路径、密钥或可执行脚本。

## 组件边界

### ApprovalManager

- 扩展审批记录和请求输入，保存可选的飞书审批主体。
- 保留现有 60 秒过期、单次授权、整轮授权、重复决策保护和事件订阅能力。
- 新增一个受校验的远程决策入口：只接受来源为飞书、处于 pending 状态、且审批主体与点击者一致的记录。

### AgentRun

- `prompt()` 的内部选项携带来源及可选审批主体。
- 当前 turn 把审批主体传给 ApprovalManager；后续工具调用不会重新从模型输出读取身份。

### IMBridge

- 收到飞书任务时，把消息的 `channelId`、`conversationId`、`senderId` 绑定到这次 turn。
- 订阅审批事件；仅为 `source: 'feishu'` 的待审批记录在原会话发送卡片。
- 记录审批 ID 与飞书卡片消息 ID 的映射，以便结果或过期后更新同一张卡片。
- 卡片发送失败时立即拒绝该审批，避免任务在无人可见的状态下等待。

### FeishuChannel

- 在现有 WebSocket EventDispatcher 中注册 `card.action.trigger`。
- 将卡片动作标准化为 `{ approvalId, decision, actorId }`，不把原始飞书 payload 传入 Agent 或审批逻辑。
- 通过现有的 `send()` / `update()` 发送与更新 interactive 卡片。
- 无法识别的动作、无效 UUID 或缺失 `open_id` 一律不触发任何状态改变。

## 安全规则

1. 只读 `read` 不需要卡片；`edit`、`write`、`powershell` 必须经过审批。
2. 只有原任务发起人的飞书 `open_id` 可以决策。
3. 允许一次只消费当前审批；允许本次任务仅对同一 run 和同一 turn 有效。
4. 60 秒超时、卡片发送失败、任务取消、应用退出均按拒绝处理。
5. 卡片正文与日志使用现有脱敏逻辑；不显示 API Key、Token、Secret、Password 或完整超长文件内容。
6. 不根据卡片中的参数直接执行命令；参数仅用于查找服务端已有的审批记录，服务端重新校验决策和身份。
7. 回调重复投递、并发点击和旧卡片点击都只能得到无副作用的终态。

## 飞书后台配置

代码完成后，需要在当前飞书自建应用中新增卡片回调 `card.action.trigger`，并重新创建/发布应用版本。继续使用现有的长连接订阅方式，不需要公网回调 URL 或内网穿透。

## 测试与验收

- 单元测试：卡片构造、取消、过期、重复点击、未知审批 ID、错误决策值。
- 授权测试：原发起人可批准；同群其他人和跨会话用户被拒绝。
- 集成测试：飞书任务触发审批卡片；允许一次和允许本次任务分别改变工具放行范围；卡片在完成/过期后更新。
- 回归测试：桌面/Web 审批、飞书只读任务、既有 IM 队列与命令行为保持不变。
- 手工验收：在飞书后台订阅 `card.action.trigger` 并发布后，用真实飞书账号从手机完成一次批准与一次拒绝。

## 参考

- 飞书交互式卡片与回调：<https://open.feishu.cn/document/home/quickly-develop-interactive-cards/introduction>
- 当前 `@larksuiteoapi/node-sdk` 的 `CardActionHandler` 与 `card.action.trigger` 示例：`node_modules/@larksuiteoapi/node-sdk/README.zh.md`
