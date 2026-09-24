# SQLite Runtime State Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将可靠性队列、定时任务、计费用量和长期记忆接入 `data/db/messages.db`，并保证重启恢复、幂等与失败可追踪。

**Architecture:** 扩展现有 `SqliteStore`，由仓储方法封装 SQL；业务模块只使用明确的输入/输出类型。迁移版本从 v2 升到 v3，所有写入使用事务或幂等约束，敏感凭证不入库。

**Tech Stack:** Node.js 26 `node:sqlite`、TypeScript、Vitest、现有 Agent/IM Bridge。

**Spec:** `docs/superpowers/specs/2026-09-24-runtime-state-sqlite-phase2-design.md`

## Global Constraints

- 数据库固定为 `data/db/messages.db`，自动创建目录并使用 WAL 与外键。
- API Key、App Secret、Token、密码、完整鉴权头和原始敏感工具输入不得写入 SQLite。
- 迁移版本单调递增；旧 v2 数据库必须可迁移到 v3。
- 重试必须有最大次数；`sending` 状态在启动恢复时回到 `pending`。
- usage ledger 只追加，不更新历史 token 记录。

## Review Focus

- 重复 channel message 或 retry idempotency key 不得产生重复行。
- 进程崩溃留下的 `sending` 队列项必须可恢复且不重复发送。
- 定时任务过期、禁用和重复执行必须有明确状态。
- token 缺失或模型返回异常时仍保存可审计的 usage 记录。
- 长期记忆必须支持软删除，并按作用域隔离。

### Task 1: SQLite v3 schema and reliability queue

**Files:**
- Modify: `src/storage/sqlite.ts`
- Modify: `tests/sqlite-store.test.ts`
- Create: `src/storage/reliability.ts`
- Create: `tests/reliability-store.test.ts`

**Interfaces:**
- `ReliabilityQueueItem`: `id`, `channelId`, `conversationId`, `idempotencyKey`, `payload`, `status`, `attempts`, `nextAttemptAt`, `lastError`.
- `SqliteStore.enqueueReliability(input): string` (idempotent), `claimReliability(now): ReliabilityQueueItem[]`, `markReliabilitySent(id)`, `markReliabilityFailed(id, error, nextAttemptAt, dead)`.
- `SqliteStore.recoverReliability(now)`: changes `sending` to `pending`.

- [ ] Write failing tests for v3 tables, unique idempotency, claim, recovery and dead-letter transition.
- [ ] Run `npm test -- tests/sqlite-store.test.ts tests/reliability-store.test.ts` and observe missing v3 APIs.
- [ ] Add migration v3 tables `reliability_queue` and `reliability_attempts`, indexes, and typed store methods. Claim must atomically update `pending` rows to `sending`.
- [ ] Run focused tests, then `npm run typecheck`.
- [ ] Commit: `feat: persist reliability queue in sqlite`.

### Task 2: Usage ledger

**Files:**
- Modify: `src/storage/sqlite.ts`
- Modify: `src/agent/run.ts`
- Create: `tests/usage-ledger.test.ts`

**Interfaces:**
- `UsageLedgerEntry`: `runId`, optional conversation/workspace/profile IDs, provider/model, input/output/cache tokens, latencyMs, estimatedCost, createdAt.
- `SqliteStore.appendUsage(entry): string` and `SqliteStore.listUsage(filter?)`.

- [ ] Add failing tests proving append-only rows, nullable token fields, and totals by model/date.
- [ ] Run `npm test -- tests/usage-ledger.test.ts` and verify RED.
- [ ] Add `usage_ledger` migration/table and store methods; use a transaction for event-derived writes.
- [ ] Connect Agent session completion/usage events to `appendUsage` without persisting prompt secrets or raw tool input.
- [ ] Run focused tests, full `npm test`, and `npm run typecheck`.
- [ ] Commit: `feat: record agent usage ledger`.

### Task 3: Scheduled tasks

**Files:**
- Modify: `src/storage/sqlite.ts`
- Create: `src/scheduler/task-store.ts`
- Create: `tests/scheduled-task-store.test.ts`
- Modify: `src/index.ts` (startup recovery hook only)

**Interfaces:**
- `ScheduledTask`: `id`, `name`, `schedule`, `conversationId`, `payload`, `enabled`, `nextRunAt`, timestamps.
- `TaskRun`: `id`, `taskId`, `runId`, `status`, `startedAt`, `finishedAt`, `error`.
- Store methods: `upsertTask`, `getDueTasks(now)`, `claimTaskRun(taskId, now)`, `finishTaskRun(runId, result)`, `disableTask(id)`.

- [ ] Add failing tests for due-task selection, disabled tasks, duplicate claim and failed execution records.
- [ ] Run focused tests and verify RED.
- [ ] Add `scheduled_tasks`/`task_runs` migration and transactional claim logic.
- [ ] Add startup recovery that does not execute tasks itself; it only normalizes stale claims and computes the next due time.
- [ ] Run focused tests, full `npm test`, and typecheck.
- [ ] Commit: `feat: persist scheduled task state`.

### Task 4: Long-term memory and final integration

**Files:**
- Modify: `src/storage/sqlite.ts`
- Create: `src/memory/memory-store.ts`
- Create: `tests/memory-store.test.ts`
- Modify: `src/im/bridge.ts` (conversation-scoped memory hooks)
- Modify: `.env.example`
- Modify: `日志.md`

**Interfaces:**
- `MemoryRecord`: `id`, scope (`global|workspace|conversation`), scopeId, content, source, importance, accessCount, deletedAt, timestamps.
- `SqliteStore.insertMemory`, `searchMemories(scope, scopeId, query)`, `touchMemory(id)`, `softDeleteMemory(id)`.

- [ ] Add failing tests for scope isolation, keyword search, touch/update, and soft delete.
- [ ] Run focused tests and verify RED.
- [ ] Add `memories` table and repository methods; deleted rows never appear in search.
- [ ] Let IM bridge read/write only conversation-scoped memory through the repository; do not inject raw secrets into prompts.
- [ ] Add configuration/documentation for database path and retention, then run `npm run typecheck`, `npm run build`, and `npm test`.
- [ ] Commit: `feat: persist long-term memories and finish runtime state v3`.

## Final Verification

Run:

```powershell
npm run typecheck
npm run build
npm test
git diff --check
```

Confirm a clean `data/db/messages.db` migration from v2 to v3 in a temporary directory and record the result in `日志.md`.
