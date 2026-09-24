# SQLite 运行时状态第二阶段设计

## 目标

在 `data/db/messages.db` 中继续收敛四类运行时状态：渠道可靠性队列、定时任务、计费用量、长期记忆。第一阶段已经持久化消息、会话、工作区和 Agent Profile；本阶段不改变现有会话恢复行为。

## 数据边界

SQLite 保存业务状态、可重试元数据和统计数据；API Key、App Secret、Token、密码、完整鉴权头和原始敏感工具输入仍只来自环境变量或内存，不写入数据库。

## 表设计

### `reliability_queue`

- `id`、`channel_id`、`conversation_id`、`message_id`
- `payload_json`（仅保存已脱敏的发送内容）
- `status`：`pending` / `sending` / `sent` / `failed` / `dead`
- `attempts`、`next_attempt_at`、`last_error`
- `idempotency_key` 唯一约束、`created_at`、`updated_at`

失败重试使用指数退避；超过最大次数进入 `dead`，不无限重试。成功发送后保留记录用于审计和去重。

### `scheduled_tasks` 与 `task_runs`

任务定义保存 `id`、名称、cron/间隔表达式、目标会话、任务输入、启用状态、下次运行时间和时间戳。执行记录保存开始/结束时间、状态、错误摘要和关联 `run_id`。定时任务不保存秘密；执行前再次从当前配置读取模型和渠道凭证。

### `usage_ledger`

每次模型请求写一条不可变记录：`run_id`、会话、模型、provider、输入 token、输出 token、缓存 token、请求耗时、估算费用和时间戳。费用是可重新计算的统计字段，不能反向修改原始 token 记录。

### `memories`

保存 `id`、作用域（全局/工作区/会话）、内容、来源、重要度、访问次数、最后访问时间、创建和更新时间。删除使用软删除字段；检索按作用域、状态和更新时间过滤。本阶段不强制引入向量数据库，先提供关键词/标签检索接口。

## 运行时接入顺序

1. SQLite migration v3 与类型安全 Store 方法。
2. 可靠性队列：发送失败入队，重启后继续处理。
3. 计费事件：从 Agent 事件流写入 usage ledger。
4. 定时任务：定义/执行/恢复，失败进入 task_runs。
5. 长期记忆：写入、查询、软删除和会话作用域关联。

## 恢复与一致性

- 所有写入使用 SQLite 事务；幂等键防止飞书消息或重试重复入账。
- 启动时将 `sending` 恢复为 `pending`，将过期任务标记为失败或重新计算下一次执行时间。
- 数据库目录自动创建，启用 WAL 和外键约束；迁移版本单调递增。
- Store 层不暴露底层 SQL 给业务模块，业务只调用命名方法。

## 验证标准

- 新库和旧 v2 库都能迁移到 v3。
- 重启后队列、任务、用量和记忆可读回。
- 重复幂等键不产生重复消息或重复用量。
- 失败重试有上限并可进入 dead-letter 状态。
- `npm run typecheck`、`npm test` 和后端构建通过。
