# Dangerous Operation Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a backend-enforced approval gate so file reads run directly while `edit`, `write`, and `powershell` wait for an explicit one-time or current-turn decision from the Electron chat client.

**Architecture:** An engine-owned `ApprovalManager` tracks pending decisions, desktop heartbeat state, and turn-scoped grants. Each `AgentRun` installs a pi `tool_call` extension that calls the manager before dangerous tools execute and mirrors approval lifecycle events into the existing Run SSE log. Hono exposes query/decision/heartbeat APIs, while the React chat timeline renders actionable approval cards and sends decisions back to the backend.

**Tech Stack:** TypeScript, Node.js, Hono, Zod, `@earendil-works/pi-coding-agent` inline extensions, React 19, Vitest, Testing Library, SSE.

**Spec:** `docs/superpowers/specs/2026-09-24-operation-approval-design.md`

## Global Constraints

- `read` executes without approval; `edit`, `write`, and `powershell` require backend approval before execution.
- Decisions are exactly `allow_once`, `allow_turn`, and `deny`.
- A turn grant expires on `agent_settled`, prompt failure, abort, or Run close.
- Missing desktop heartbeat, approval timeout, malformed input, and internal approval errors fail closed.
- Feishu cannot approve operations; when no Electron approval client is active, its dangerous tool calls are rejected immediately.
- Approval UI must display only real tool calls already received by the backend; it must not predict a total file count.
- Do not add Windows UAC, permanent grants, remote multi-user authentication, or Feishu-card approval.
- Continue to support Windows host tool names and the existing container/bash configuration without silently treating `bash` as approved; this feature gates `powershell` exactly as specified.

## Review Focus

- A stale Electron heartbeat must never keep approval capability alive; Task 1 tests expiry at the exact boundary.
- A delayed decision arriving after timeout or Run close must return a conflict and must not revive execution; Tasks 1 and 3 test this.
- Two concurrent pending calls followed by `allow_turn` must resolve safely without double settlement; Task 1 tests both promises.
- Approval summaries containing API-key-like command values must be redacted before entering SSE or API output; Task 1 tests redaction.
- An SSE reconnect must restore unresolved approval cards from replayed events plus the pending-query response without duplicates; Tasks 4 and 5 test stable IDs and merge behavior.

---

## File Structure

- Create `src/agent/approval.ts`: approval types, summaries/redaction, heartbeat, pending Promise lifecycle, and turn grants.
- Create `tests/approval.test.ts`: deterministic unit tests for `ApprovalManager` using an injected clock/timer boundary.
- Modify `src/agent/run.ts`: prompt source/turn state, inline `tool_call` gate, approval event recording, and lifecycle cleanup.
- Modify `src/agent/engine.ts`: own and expose one `ApprovalManager`, pass it into every Run.
- Create `tests/agent-approval.test.ts`: integration seam between pi extension events and the manager, using exported extension-factory construction rather than a live model.
- Modify `src/app.ts`: schemas and approval HTTP endpoints.
- Modify `tests/agent.test.ts`: API decision, heartbeat, pending-list, source, and conflict tests.
- Modify `src/im/bridge.ts` and `tests/im-bridge.test.ts`: mark Feishu prompts with `source: 'feishu'` and verify fail-closed feedback.
- Modify `web/src/lib/api.ts`: approval DTOs and HTTP methods; add prompt source.
- Modify `web/src/lib/conversation.ts` and `web/src/lib/conversation.test.ts`: map approval events into stable conversation items.
- Create `web/src/components/ApprovalCard.tsx` and `web/src/components/ApprovalCard.test.tsx`: render and submit the three decisions.
- Modify `web/src/components/ChatTimeline.tsx`: render approval items and forward decisions.
- Modify `web/src/App.tsx`: Electron heartbeat, pending recovery, deduplication, and decision callback.
- Modify `web/src/App.css`: approval card states and responsive layout.
- Modify `日志.md`: record behavior, constraints, and verification evidence.

---

### Task 1: Build the approval state machine

**Files:**
- Create: `src/agent/approval.ts`
- Create: `tests/approval.test.ts`

**Interfaces:**
- Produces: `ApprovalManager`, `ApprovalError`, `ApprovalRecord`, `ApprovalDecision`, `ApprovalOutcome`, `PromptSource`, `ApprovalEvent`, `summarizeToolCall`.
- Constructor: `new ApprovalManager({ timeoutMs?, clientTtlMs?, now?, setTimer?, clearTimer? })`.
- Main methods:
  - `heartbeat(clientId: string): void`
  - `hasActiveClient(): boolean`
  - `beginTurn(runId: string, turnId: string, source: PromptSource): void`
  - `request(input: ApprovalRequestInput): Promise<ApprovalOutcome>`
  - `decide(id: string, decision: ApprovalDecision): ApprovalRecord`
  - `listPending(runId?: string): ApprovalRecord[]`
  - `endTurn(runId: string, reason: string): void`
  - `subscribe(listener: (event: ApprovalEvent) => void): () => void`

- [ ] **Step 1: Write failing state-machine tests**

Create tests covering direct pending creation, one-time allow, turn allow, deny, timeout, inactive client, late decision conflict, turn cleanup, concurrent pending resolution, heartbeat boundary, and redaction. Use fake time rather than sleeping:

```ts
const clock = { now: 1_000 }
const manager = new ApprovalManager({
  now: () => clock.now,
  timeoutMs: 30_000,
  clientTtlMs: 10_000,
})

manager.heartbeat('desktop-1')
manager.beginTurn('run-1', 'turn-1', 'desktop')
const pending = manager.request({
  runId: 'run-1',
  turnId: 'turn-1',
  source: 'desktop',
  cwd: 'F:\\project',
  toolName: 'write',
  input: { path: 'src/a.ts', content: 'hello' },
})
const [record] = manager.listPending('run-1')
expect(record?.summary).toContain('src/a.ts')
manager.decide(record!.id, 'allow_once')
await expect(pending).resolves.toEqual({ allowed: true, scope: 'once' })
```

For concurrent calls, create two `request()` promises, decide the first with `allow_turn`, and assert both settle as allowed while a later request in the same turn returns immediately. For redaction, pass `command: '$env:DEEPSEEK_API_KEY="sk-secret"; npm test'` and assert neither the public record nor emitted event contains `sk-secret`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/approval.test.ts`

Expected: FAIL because `src/agent/approval.ts` does not exist.

- [ ] **Step 3: Implement the approval types and summaries**

Define the public contracts exactly:

```ts
export type PromptSource = 'desktop' | 'web' | 'feishu'
export type ApprovalDecision = 'allow_once' | 'allow_turn' | 'deny'
export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired' | 'cancelled'

export interface ApprovalRecord {
  id: string
  runId: string
  turnId: string
  toolName: 'edit' | 'write' | 'powershell'
  source: PromptSource
  cwd: string
  summary: string
  details: Record<string, unknown>
  status: ApprovalStatus
  createdAt: string
  expiresAt: string
}

export type ApprovalOutcome =
  | { allowed: true; scope: 'once' | 'turn' }
  | { allowed: false; reason: string }

export class ApprovalError extends Error {
  constructor(
    readonly code: 'approval_not_found' | 'approval_not_pending',
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message)
  }
}
```

`summarizeToolCall()` must normalize `path`/`file_path`, truncate previews to 2,000 characters, include write character count, include PowerShell cwd, and redact values following names matching `KEY|TOKEN|SECRET|PASSWORD` plus `sk-...` tokens.

- [ ] **Step 4: Implement Promise settlement, heartbeat, grants, and cleanup**

Use one internal map for pending entries, one `Set<string>` keyed by `${runId}:${turnId}` for turn grants, and a listener set. `request()` must:

```ts
if (!DANGEROUS_TOOLS.has(input.toolName)) {
  return { allowed: true, scope: 'once' }
}
if (this.turnGrants.has(turnKey(input.runId, input.turnId))) {
  return { allowed: true, scope: 'turn' }
}
if (!this.hasActiveClient()) {
  return { allowed: false, reason: '需要在桌面客户端确认此操作' }
}
```

Every exit path must clear its timer before resolving. `decide(..., 'allow_turn')` adds the turn grant and resolves every pending entry with the same run/turn. `endTurn()` deletes the grant and resolves remaining entries as cancelled. Unknown IDs throw `ApprovalError('approval_not_found', ..., 404)`; resolved/expired IDs retained as tombstones until turn cleanup throw `ApprovalError('approval_not_pending', ..., 409)`. Keeping `ApprovalError` in `approval.ts` avoids a circular import back to `run.ts`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- tests/approval.test.ts`

Expected: all approval manager tests PASS with no open-handle warning.

- [ ] **Step 6: Commit the state machine**

```powershell
git add src/agent/approval.ts tests/approval.test.ts
git commit -m "feat: add dangerous operation approval manager"
```

---

### Task 2: Gate pi tool calls inside AgentRun

**Files:**
- Modify: `src/agent/run.ts`
- Modify: `src/agent/engine.ts`
- Create: `tests/agent-approval.test.ts`
- Modify: `tests/agent.test.ts`

**Interfaces:**
- Consumes: `ApprovalManager.request`, `beginTurn`, `endTurn`, `subscribe` from Task 1.
- Produces: `PromptOptions`, `createApprovalExtension`, engine `getApprovalManager()`.

- [ ] **Step 1: Write failing extension-gate tests**

Export a small factory so the gate is testable without invoking a real model:

```ts
export interface PromptOptions {
  streamingBehavior?: 'steer' | 'followUp'
  source?: PromptSource
}

export function createApprovalExtension(context: {
  approvals: ApprovalManager
  runId: string
  cwd: string
  getTurn: () => { id: string; source: PromptSource } | undefined
}): ExtensionFactory
```

In the test, provide a fake `ExtensionAPI.on` collector, invoke the registered `tool_call` handler, and assert:

```ts
expect(await call({ toolName: 'read', input: { path: 'a.ts' } })).toBeUndefined()

const blocked = await call({
  toolName: 'write',
  input: { path: 'a.ts', content: 'x' },
})
expect(blocked).toEqual({
  block: true,
  reason: '需要在桌面客户端确认此操作',
})
```

Add cases for approval success, deny, no active turn, manager failure (fail closed), and a non-specified `bash` call remaining unaffected rather than silently inheriting PowerShell policy.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/agent-approval.test.ts`

Expected: FAIL because `createApprovalExtension` and `PromptOptions` do not exist.

- [ ] **Step 3: Wire ApprovalManager into the engine and Run**

`AgentEngine` owns one manager:

```ts
private readonly approvals: ApprovalManager

constructor(options: AgentEngineOptions = {}) {
  this.approvals = options.approvals ?? new ApprovalManager()
  // existing workspace/default initialization remains unchanged
}

getApprovalManager(): ApprovalManager {
  return this.approvals
}
```

Add `approvals?: ApprovalManager` to `AgentEngineOptions` for deterministic tests. Pass the manager as a separate argument to `AgentRun.create(...)`; do not put it in `AgentRunDefaults` or return it from `getDefaults()`.

- [ ] **Step 4: Install the inline extension without losing existing resources**

Always create a `DefaultResourceLoader` in `AgentRun.initialize`, with both optional prompt override and the inline factory:

```ts
const loader = new DefaultResourceLoader({
  cwd: this.cwd,
  agentDir: defaults.agentDir ?? getAgentDir(),
  ...(this.request.systemPrompt
    ? { systemPromptOverride: () => this.request.systemPrompt ?? '' }
    : {}),
  extensionFactories: [
    {
      name: 'miniclaw-operation-approval',
      hidden: true,
      factory: createApprovalExtension({
        approvals: this.approvals,
        runId: this.id,
        cwd: this.cwd,
        getTurn: () => this.activeTurn,
      }),
    },
  ],
})
await loader.reload()
options.resourceLoader = loader
```

Verify the installed dependency accepts the `InlineExtension` object; if its exact generic inference rejects the object, use the exported `InlineExtension` type rather than `as any`.

- [ ] **Step 5: Add turn lifecycle and approval events**

On a non-busy `prompt`, create `{ id: randomUUID(), source: options.source ?? 'web' }` before `session.prompt()`, then call `approvals.beginTurn`. Subscribe to manager events for this Run and record them through a new private `recordEvent(type, payload)` helper used by both pi session events and approval events.

On `agent_settled`, prompt rejection, `abort()`, and `close()`, call `endActiveTurn(reason)` exactly once. Keep the turn alive while a tool hook awaits approval. Update the API-level Run test to assert a second prompt starts with no inherited turn grant.

- [ ] **Step 6: Run integration and regression tests**

Run: `npm test -- tests/agent-approval.test.ts tests/agent.test.ts`

Expected: new integration tests and existing Agent API tests PASS.

- [ ] **Step 7: Commit Agent integration**

```powershell
git add src/agent/run.ts src/agent/engine.ts tests/agent-approval.test.ts tests/agent.test.ts
git commit -m "feat: gate dangerous agent tools before execution"
```

---

### Task 3: Expose approval and desktop-presence APIs

**Files:**
- Modify: `src/app.ts`
- Modify: `tests/agent.test.ts`

**Interfaces:**
- Consumes: engine `getApprovalManager()`, `ApprovalDecision`, and `PromptSource`.
- Produces:
  - `GET /api/agent/approvals`
  - `POST /api/agent/approvals/:id/decision`
  - `POST /api/agent/approval-clients/heartbeat`
  - prompt body field `source`.

- [ ] **Step 1: Write failing HTTP tests**

Add tests for:

```ts
await app.request('/api/agent/approval-clients/heartbeat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId: 'desktop-test' }),
})

await app.request('/api/agent/approvals?runId=run-1&status=pending')

await app.request(`/api/agent/approvals/${approvalId}/decision`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ decision: 'allow_turn' }),
})
```

Assert 400 for invalid decisions/client IDs, 404 for unknown approval IDs, 409 for already-resolved approvals, and that a prompt with `source: 'desktop'` reaches `run.prompt` unchanged.

- [ ] **Step 2: Run focused HTTP tests and verify RED**

Run: `npm test -- tests/agent.test.ts`

Expected: FAIL with 404 responses for the new endpoints.

- [ ] **Step 3: Add schemas and routes**

Add exact schemas:

```ts
const promptSchema = z.object({
  text: z.string().min(1),
  streamingBehavior: z.enum(['steer', 'followUp']).optional(),
  source: z.enum(['desktop', 'web', 'feishu']).default('web'),
})
const decisionSchema = z.object({
  decision: z.enum(['allow_once', 'allow_turn', 'deny']),
})
const heartbeatSchema = z.object({ clientId: z.string().min(1).max(128) })
```

Filter `listPending` by `runId`; accept only `status=pending` and return `{ approvals }`. Extend `errorResponse` with an `ApprovalError` branch so late/duplicate decisions retain stable codes and HTTP statuses.

- [ ] **Step 4: Verify API and all backend tests**

Run: `npm test`

Expected: all backend tests PASS with zero failures.

- [ ] **Step 5: Commit API endpoints**

```powershell
git add src/app.ts tests/agent.test.ts
git commit -m "feat: expose operation approval API"
```

---

### Task 4: Add typed frontend approval data flow

**Files:**
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/lib/conversation.ts`
- Modify: `web/src/lib/conversation.test.ts`

**Interfaces:**
- Produces: `ApprovalRecord`, `ApprovalDecision`, `listPendingApprovals`, `decideApproval`, `heartbeatApprovalClient`, and `ConversationItem` kind `approval`.

- [ ] **Step 1: Extend conversation tests with approval lifecycle events**

Add `approval_requested` followed by `approval_resolved` events sharing the same approval ID. Assert `buildConversation` returns one item, not duplicates:

```ts
expect(items).toContainEqual(expect.objectContaining({
  id: 'approval-approval-1',
  kind: 'approval',
  approval: expect.objectContaining({
    id: 'approval-1',
    toolName: 'powershell',
    status: 'allowed',
  }),
}))
```

Also test replayed duplicate events and a pending record merged from the REST recovery call.

- [ ] **Step 2: Run frontend focused tests and verify RED**

Run: `npm --prefix web test -- --run src/lib/conversation.test.ts`

Expected: FAIL because `ConversationItem` has no approval variant.

- [ ] **Step 3: Add API types and functions**

Use the same DTO field names as the backend and extend `PromptInput` with `source?: PromptSource`:

```ts
export function listPendingApprovals(runId?: string): Promise<{ approvals: ApprovalRecord[] }>
export function decideApproval(id: string, decision: ApprovalDecision): Promise<ApprovalRecord>
export function heartbeatApprovalClient(clientId: string): Promise<{ active: true }>
```

URL-encode both Run and approval IDs. Reuse `request` and `jsonInit`; do not create a second fetch wrapper.

- [ ] **Step 4: Map approval events by stable ID**

Add:

```ts
| {
    id: string
    kind: 'approval'
    approval: ApprovalRecord
    at: string
  }
```

Track an `approvalIndexes` map like tool activities. A resolved/expired event updates the existing item; if replay begins with a terminal event, insert it once. Add a `mergePendingApprovals(events, approvals)` helper or optional second argument so REST recovery does not duplicate an SSE item.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm --prefix web test -- --run src/lib/conversation.test.ts`

Expected: conversation tests PASS.

```powershell
git add web/src/lib/api.ts web/src/lib/conversation.ts web/src/lib/conversation.test.ts
git commit -m "feat: add frontend approval data model"
```

---

### Task 5: Render and operate approval cards in chat

**Files:**
- Create: `web/src/components/ApprovalCard.tsx`
- Create: `web/src/components/ApprovalCard.test.tsx`
- Modify: `web/src/components/ChatTimeline.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.css`

**Interfaces:**
- Consumes: Task 4 approval DTOs and functions.
- Produces: `ApprovalCard({ approval, onDecision })`, Electron-only heartbeat, pending recovery, and timeline decision handling.

- [ ] **Step 1: Write failing component tests**

Render a pending PowerShell approval and assert the command and three buttons are visible. Click each button in parameterized tests and verify:

```ts
expect(onDecision).toHaveBeenCalledWith('approval-1', 'allow_turn')
```

Use a deferred Promise to assert all buttons are disabled while submitting. Reject it and assert an inline error appears and buttons become enabled. Render terminal statuses and assert no action buttons remain.

- [ ] **Step 2: Run component test and verify RED**

Run: `npm --prefix web test -- --run src/components/ApprovalCard.test.tsx`

Expected: FAIL because `ApprovalCard.tsx` does not exist.

- [ ] **Step 3: Implement the card**

Use Phosphor icons already installed. The card must show:

- `AI 准备修改文件` for `edit`/`write`, or `AI 准备运行 PowerShell`;
- path/command summary and current cwd;
- `来源：飞书` when applicable;
- buttons `仅允许这一次`, `允许本次任务`, `拒绝`;
- helper copy `仅当前这轮对话有效，回答结束后自动失效` next to turn approval.

Keep submission state local to the card, but update the final status only from the returned backend record/SSE event.

- [ ] **Step 4: Integrate the card and recover pending approvals**

Change `ChatTimeline` props to include recovered pending records and `onApprovalDecision`. In `App.tsx`:

- generate one stable client ID per renderer lifetime with `crypto.randomUUID()`;
- only heartbeat when `window.miniClawDesktop` exists;
- send one heartbeat immediately and repeat every 5 seconds;
- await a fresh heartbeat in `handlePrompt` before sending a desktop-sourced prompt, eliminating the startup race where the user sends before the first interval completes;
- stop the interval on unmount;
- call `listPendingApprovals(selectedId)` after selecting/reconnecting a Run;
- merge REST records with SSE by approval ID;
- send prompts with `source: window.miniClawDesktop ? 'desktop' : 'web'`;
- clear recovered records when switching Runs.

The backend TTL in Task 1 must be at least 15 seconds so one missed 5-second heartbeat does not instantly revoke capability.

- [ ] **Step 5: Add styles without changing the selected chat layout**

Add `.approval-card`, `.approval-command`, `.approval-actions`, and status modifier classes. Use the existing purple accent for allow actions, a neutral outline for one-time allow, and a restrained red treatment for deny. At widths below 640px stack the buttons vertically; ensure long commands wrap and never force horizontal page scrolling.

- [ ] **Step 6: Run frontend verification**

Run: `npm --prefix web test`

Expected: all frontend tests PASS.

Run: `npm --prefix web run lint`

Expected: ESLint exits 0.

Run: `npm --prefix web run build`

Expected: TypeScript and Vite build exit 0.

- [ ] **Step 7: Commit the UI**

```powershell
git add web/src/components/ApprovalCard.tsx web/src/components/ApprovalCard.test.tsx web/src/components/ChatTimeline.tsx web/src/App.tsx web/src/App.css
git commit -m "feat: add operation approval cards to chat"
```

---

### Task 6: Enforce Feishu source behavior and finish regression coverage

**Files:**
- Modify: `src/im/bridge.ts`
- Modify: `tests/im-bridge.test.ts`
- Modify: `日志.md`

**Interfaces:**
- Consumes: `PromptOptions.source` from Task 2.
- Produces: every Feishu bridge prompt uses `{ source: 'feishu' }`.

- [ ] **Step 1: Write the failing Feishu source test**

Update the fake Run so it records prompt options, then assert:

```ts
expect(run.prompts[0]).toEqual({
  text: '请修改文件',
  options: { source: 'feishu' },
})
```

Add a bridge-level failure case where the fake Run emits an assistant explanation after a blocked tool and verify the channel sends `需要在桌面客户端确认` rather than hanging.

- [ ] **Step 2: Run focused test and verify RED**

Run: `npm test -- tests/im-bridge.test.ts`

Expected: FAIL because the bridge currently calls `run.prompt(message.text)` without source metadata.

- [ ] **Step 3: Mark Feishu prompts explicitly**

Change the bridge call to:

```ts
await run.prompt(message.text, { source: 'feishu' })
```

Update the `IMRun` Pick/interface typing so the option is accepted without weakening it to `any`.

- [ ] **Step 4: Run complete automated verification**

Run each command independently and require exit code 0:

```powershell
npm test
npm run typecheck
npm run build
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
git diff --check
```

Expected: backend and frontend tests report zero failures; both builds and lint pass; `git diff --check` prints no errors.

- [ ] **Step 5: Update the engineering log**

Append a dated `日志.md` entry listing the permission rules, backend enforcement point, API/UI behavior, Feishu fail-closed behavior, and exact verification counts from Step 4. Do not claim visual QA because the user prohibited computer control.

- [ ] **Step 6: Re-run verification after documentation and commit**

Run the same commands from Step 4, then:

```powershell
git add src/im/bridge.ts tests/im-bridge.test.ts 日志.md
git commit -m "feat: enforce approvals for Feishu agent tasks"
```

Expected: verification remains green and the final commit contains only Task 6 files.

---

## Final Review Gate

- Confirm the backend gate, not the UI, is what prevents execution.
- Confirm every pending Promise settles on allow, deny, timeout, abort, close, and turn end.
- Confirm `allow_turn` cannot leak into the next user message.
- Confirm approval API payloads and SSE records never contain an unredacted test secret.
- Confirm Electron absence suppresses heartbeats and causes dangerous operations to fail closed.
- Confirm no desktop window, browser, or computer-control tool was used during implementation or verification.
- Run `git status --short` and review every remaining uncommitted file separately from the task commits.
