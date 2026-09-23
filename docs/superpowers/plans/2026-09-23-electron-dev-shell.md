# Electron Development Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Windows Electron development entry that starts or reuses the MiniClaw backend and Vite frontend, waits for both services, and opens the existing React client in a secure desktop window.

**Architecture:** Keep Electron as a thin desktop supervisor. A testable `dev-services.mjs` module owns endpoint inspection, child startup, readiness, timeout, and owned-process cleanup; `main.mjs` wires that module to Electron lifecycle and a security-focused `BrowserWindow`.

**Tech Stack:** Electron 44.4.5, Node.js ESM, existing Vite/React frontend, Vitest, Windows PowerShell/process APIs.

**Spec:** `docs/superpowers/specs/2026-09-23-electron-dev-shell-design.md`

## Global Constraints

- Windows development mode only; no installer, tray, updater, or autostart.
- `npm run desktop:dev` must automatically start or reuse both backend and Vite.
- Reuse a service only after its endpoint matches the expected MiniClaw/Vite response.
- Never terminate a process that Electron did not start.
- `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true` are mandatory.
- Do not expose raw Node.js, `ipcRenderer`, filesystem, Shell, or command execution to React.
- Keep existing `npm run dev` and `npm run dev:full` behavior unchanged.

## Review Focus

- Port 3000 accepts TCP but returns a non-MiniClaw response: fail as occupied and do not spawn or kill anything (Task 1 test).
- A spawned child exits before readiness: fail immediately and clean up the owned process record (Task 1 test).
- Backend starts but frontend times out: stop only the backend started by this Electron session (Task 1 test).
- Cleanup is triggered by both startup failure and `before-quit`: process tree termination remains idempotent (Task 1 test).
- Renderer tries to navigate away from the local Vite origin or open a non-HTTPS URL: deny it (Task 2 test).

---

## File Map

- `electron/dev-services.mjs`: endpoint inspection and owned child-process lifecycle; no Electron imports.
- `electron/window-policy.mjs`: pure window options and URL allow/deny decisions.
- `electron/preload.cjs`: minimal, frozen, read-only desktop metadata bridge.
- `electron/main.mjs`: Electron app, service definitions, window creation, and quit cleanup.
- `tests/electron-dev-services.test.mjs`: service lifecycle tests with network/spawn boundaries injected.
- `tests/electron-window-policy.test.mjs`: security-option and navigation-policy tests.
- `package.json`: Electron dependency and `desktop:dev` script.
- `package-lock.json`: resolved Electron dependency graph.
- `日志.md`: completed implementation and verification record.

### Task 1: Testable development-service lifecycle

**Files:**
- Create: `electron/dev-services.mjs`
- Create: `tests/electron-dev-services.test.mjs`

**Interfaces:**
- Produces: `createDevServiceManager({ services, inspect, spawnService, killTree, sleep, now })`.
- Produces: manager methods `startAll(): Promise<readonly ServiceState[]>` and `stopAll(): Promise<void>`.
- Produces: `inspectHttpService(service): Promise<'free' | 'ready' | 'occupied'>` for real TCP/HTTP inspection.
- Consumes: service objects with `name`, `host`, `port`, `probeUrl`, `validateResponse`, `command`, `args`, `cwd`, `env`, `timeoutMs`, and `pollMs`.

- [ ] **Step 1: Write failing lifecycle tests**

Create `tests/electron-dev-services.test.mjs` with table-complete fake dependencies. The fake child must mirror the production boundary: `{ pid, exitCode, once(event, handler), removeListener(event, handler) }`.

```js
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createDevServiceManager } from '../electron/dev-services.mjs'

function child(pid = 41) {
  const emitter = new EventEmitter()
  return Object.assign(emitter, { pid, exitCode: null })
}

const backend = {
  name: 'backend', host: '127.0.0.1', port: 3000,
  probeUrl: 'http://127.0.0.1:3000/api/agent/health',
  validateResponse: () => true,
  command: 'node', args: ['dist/index.js'], cwd: 'F:/repo', env: {},
  timeoutMs: 100, pollMs: 1,
}

describe('Electron development service manager', () => {
  it('reuses a recognized service and never kills it', async () => {
    const spawnService = vi.fn()
    const killTree = vi.fn()
    const manager = createDevServiceManager({
      services: [backend], inspect: vi.fn().mockResolvedValue('ready'),
      spawnService, killTree, sleep: vi.fn(), now: vi.fn(() => 0),
    })
    await expect(manager.startAll()).resolves.toMatchObject([{ name: 'backend', owned: false }])
    await manager.stopAll()
    expect(spawnService).not.toHaveBeenCalled()
    expect(killTree).not.toHaveBeenCalled()
  })

  it('rejects an occupied unknown endpoint without spawning or killing', async () => {
    const spawnService = vi.fn()
    const killTree = vi.fn()
    const manager = createDevServiceManager({
      services: [backend], inspect: vi.fn().mockResolvedValue('occupied'),
      spawnService, killTree, sleep: vi.fn(), now: vi.fn(() => 0),
    })
    await expect(manager.startAll()).rejects.toThrow('backend port 3000 is occupied')
    expect(spawnService).not.toHaveBeenCalled()
    expect(killTree).not.toHaveBeenCalled()
  })

  it('starts a free service, waits for readiness, and kills its tree once', async () => {
    const spawned = child()
    const inspect = vi.fn().mockResolvedValueOnce('free').mockResolvedValueOnce('free').mockResolvedValue('ready')
    const killTree = vi.fn().mockResolvedValue(undefined)
    const manager = createDevServiceManager({
      services: [backend], inspect, spawnService: vi.fn(() => spawned),
      killTree, sleep: vi.fn().mockResolvedValue(undefined), now: vi.fn(() => 0),
    })
    await expect(manager.startAll()).resolves.toMatchObject([{ name: 'backend', owned: true, pid: 41 }])
    await manager.stopAll()
    await manager.stopAll()
    expect(killTree).toHaveBeenCalledTimes(1)
    expect(killTree).toHaveBeenCalledWith(41)
  })

  it('fails immediately when a child exits before readiness', async () => {
    const spawned = child()
    const inspect = vi.fn().mockResolvedValueOnce('free').mockImplementation(async () => {
      spawned.exitCode = 1
      spawned.emit('exit', 1)
      return 'free'
    })
    const manager = createDevServiceManager({
      services: [backend], inspect, spawnService: vi.fn(() => spawned),
      killTree: vi.fn(), sleep: vi.fn().mockResolvedValue(undefined), now: vi.fn(() => 0),
    })
    await expect(manager.startAll()).rejects.toThrow('backend exited before becoming ready')
  })

  it('cleans an earlier owned service when a later service times out', async () => {
    const frontend = { ...backend, name: 'web', port: 5173, probeUrl: 'http://127.0.0.1:5173', timeoutMs: 2 }
    const children = [child(41), child(42)]
    let clock = 0
    const inspect = vi.fn(async (service) => service.name === 'backend' && clock > 0 ? 'ready' : 'free')
    const killTree = vi.fn().mockResolvedValue(undefined)
    const manager = createDevServiceManager({
      services: [backend, frontend], inspect, spawnService: vi.fn(() => children.shift()),
      killTree, sleep: vi.fn(async () => { clock += 2 }), now: vi.fn(() => clock),
    })
    await expect(manager.startAll()).rejects.toThrow('web did not become ready')
    expect(killTree).toHaveBeenCalledWith(41)
    expect(killTree).toHaveBeenCalledWith(42)
  })
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/electron-dev-services.test.mjs`

Expected: FAIL because `electron/dev-services.mjs` does not exist.

- [ ] **Step 3: Implement the minimal service manager**

Create `electron/dev-services.mjs`. Use `node:net` to distinguish a free TCP port from an occupied endpoint, `fetch` to validate an occupied endpoint, `node:child_process.spawn` with `shell: false`, and an exact-PID Windows process-tree terminator.

Required public shape:

```js
export async function inspectHttpService(service) { /* TCP check, then HTTP validation */ }

export async function killOwnedProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  // Windows-only phase: taskkill targets the exact owned PID and descendants.
  await execFilePromise('taskkill.exe', ['/PID', String(pid), '/T', '/F'])
}

export function createDevServiceManager({
  services,
  inspect = inspectHttpService,
  spawnService = spawnConfiguredService,
  killTree = killOwnedProcessTree,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  const states = []
  let stopped = false

  async function stopAll() {
    if (stopped) return
    stopped = true
    const owned = states.filter((state) => state.owned && state.pid).reverse()
    await Promise.allSettled(owned.map((state) => killTree(state.pid)))
  }

  async function startAll() {
    try {
      for (const service of services) {
        const initial = await inspect(service)
        if (initial === 'ready') {
          states.push({ name: service.name, owned: false })
          continue
        }
        if (initial === 'occupied') {
          throw new Error(`${service.name} port ${service.port} is occupied by an unrecognized service`)
        }
        const child = spawnService(service)
        const state = { name: service.name, owned: true, pid: child.pid, child }
        states.push(state)
        await waitUntilReady(service, child, { inspect, sleep, now })
      }
      return states.map(({ name, owned, pid }) => ({ name, owned, pid }))
    } catch (error) {
      await stopAll()
      throw error
    }
  }

  return { startAll, stopAll }
}
```

`waitUntilReady` must attach one `exit` listener, check `child.exitCode`, poll until `timeoutMs`, remove its listener in `finally`, and throw messages containing either `exited before becoming ready` or `did not become ready within`.

- [ ] **Step 4: Run the focused tests and make them GREEN**

Run: `npx vitest run tests/electron-dev-services.test.mjs`

Expected: 5 tests PASS.

- [ ] **Step 5: Run the full root suite**

Run: `npm test`

Expected: all existing tests plus the 5 new tests PASS.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- electron/dev-services.mjs tests/electron-dev-services.test.mjs
git commit -m "feat: manage Electron development services"
```

### Task 2: Secure Electron window and application lifecycle

**Files:**
- Create: `electron/window-policy.mjs`
- Create: `electron/preload.cjs`
- Create: `electron/main.mjs`
- Create: `tests/electron-window-policy.test.mjs`

**Interfaces:**
- Consumes: `createDevServiceManager` from Task 1.
- Produces: `createWindowOptions(preloadPath)` and `classifyNavigation(targetUrl, localOrigin)`.
- Produces: Electron bootstrap that starts services before creating `BrowserWindow`.

- [ ] **Step 1: Write failing window-policy tests**

```js
import { describe, expect, it } from 'vitest'
import { classifyNavigation, createWindowOptions } from '../electron/window-policy.mjs'

describe('Electron window policy', () => {
  it('keeps renderer privileges isolated', () => {
    expect(createWindowOptions('F:/repo/electron/preload.cjs')).toMatchObject({
      show: false,
      webPreferences: {
        preload: 'F:/repo/electron/preload.cjs',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
  })

  it.each([
    ['http://127.0.0.1:5173/runs', 'allow'],
    ['https://electronjs.org/docs', 'external'],
    ['http://example.com', 'deny'],
    ['file:///C:/Windows/System32/calc.exe', 'deny'],
    ['javascript:alert(1)', 'deny'],
  ])('classifies %s as %s', (url, expected) => {
    expect(classifyNavigation(url, 'http://127.0.0.1:5173')).toBe(expected)
  })
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/electron-window-policy.test.mjs`

Expected: FAIL because `electron/window-policy.mjs` does not exist.

- [ ] **Step 3: Implement pure window policy**

```js
export function createWindowOptions(preload) {
  return {
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true },
  }
}

export function classifyNavigation(targetUrl, localOrigin) {
  let target
  try { target = new URL(targetUrl) } catch { return 'deny' }
  if (target.origin === localOrigin) return 'allow'
  return target.protocol === 'https:' ? 'external' : 'deny'
}
```

- [ ] **Step 4: Run focused tests and make them GREEN**

Run: `npx vitest run tests/electron-window-policy.test.mjs`

Expected: all policy tests PASS.

- [ ] **Step 5: Add minimal preload**

Create `electron/preload.cjs`:

```js
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('miniClawDesktop', Object.freeze({
  platform: process.platform,
}))
```

Do not expose `ipcRenderer`, `require`, environment variables, filesystem paths, or command execution.

- [ ] **Step 6: Implement Electron main process**

Create `electron/main.mjs` with these exact service definitions and lifecycle rules:

```js
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const services = [
  {
    name: 'backend', host: '127.0.0.1', port: 3000,
    probeUrl: 'http://127.0.0.1:3000/api/agent/health',
    validateResponse: ({ response, body }) => response.ok && body.includes('"engine"'),
    command: 'node', args: ['--env-file=.env', '--import', 'tsx', 'src/index.ts'],
    cwd: projectRoot, env: process.env, timeoutMs: 30_000, pollMs: 200,
  },
  {
    name: 'web', host: '127.0.0.1', port: 5173,
    probeUrl: 'http://127.0.0.1:5173/',
    validateResponse: ({ response, body }) => response.ok && body.includes('<div id="root"></div>'),
    command: npmCommand, args: ['--prefix', 'web', 'run', 'dev', '--', '--host', '127.0.0.1'],
    cwd: projectRoot, env: process.env, timeoutMs: 30_000, pollMs: 200,
  },
]
```

Then:

- Await `manager.startAll()` inside `app.whenReady()` before creating the window.
- Create `BrowserWindow(createWindowOptions(preloadPath))`, call `loadURL('http://127.0.0.1:5173')`, and show on `ready-to-show`.
- In `will-navigate`, prevent non-local navigation. For `external`, call `shell.openExternal` only after classification returns `external`.
- Set `setWindowOpenHandler` to always return `{ action: 'deny' }`, opening only classified HTTPS URLs externally.
- On bootstrap failure, call `dialog.showErrorBox('MiniClaw 启动失败', error.message)`, clean owned services, and quit.
- Implement guarded asynchronous `before-quit` cleanup so `manager.stopAll()` completes once before the final `app.quit()`.
- Make `window-all-closed` call `app.quit()` on Windows.
- Make `SIGINT` and `SIGTERM` call `app.quit()`.

- [ ] **Step 7: Run focused and full tests**

Run:

```powershell
npx vitest run tests/electron-window-policy.test.mjs tests/electron-dev-services.test.mjs
npm test
```

Expected: all tests PASS.

- [ ] **Step 8: Commit Task 2**

```powershell
git add -- electron/window-policy.mjs electron/preload.cjs electron/main.mjs tests/electron-window-policy.test.mjs
git commit -m "feat: add secure Electron development shell"
```

### Task 3: Install Electron and expose the one-command entry

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `日志.md`

**Interfaces:**
- Consumes: `electron/main.mjs` from Task 2.
- Produces: root command `npm run desktop:dev`.

- [ ] **Step 1: Add a failing package-script test**

Extend `tests/electron-window-policy.test.mjs`:

```js
import { readFile } from 'node:fs/promises'

it('exposes the documented desktop development command', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  expect(pkg.scripts['desktop:dev']).toBe('electron electron/main.mjs')
  expect(pkg.devDependencies.electron).toBe('^44.4.5')
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run tests/electron-window-policy.test.mjs -t "exposes the documented desktop development command"`

Expected: FAIL because `desktop:dev` and Electron are absent.

- [ ] **Step 3: Install the exact Electron development dependency**

Run:

```powershell
npm install --save-dev electron@^44.4.5
```

Then add this root script to `package.json`:

```json
"desktop:dev": "electron electron/main.mjs"
```

- [ ] **Step 4: Make the package-script test GREEN**

Run: `npx vitest run tests/electron-window-policy.test.mjs -t "exposes the documented desktop development command"`

Expected: PASS.

- [ ] **Step 5: Append the project log**

Append a dated entry to `日志.md` stating the files added, the one-command workflow, reuse/cleanup rules, security defaults, and actual verification results. Do not claim manual Electron verification until Task 4 completes.

- [ ] **Step 6: Commit Task 3**

```powershell
git add -- package.json package-lock.json tests/electron-window-policy.test.mjs 日志.md
git commit -m "build: add Electron desktop development command"
```

### Task 4: End-to-end verification and handoff

**Files:**
- Modify if defects are found: files owned by Tasks 1-3.
- Modify: `日志.md` with final observed results only.

**Interfaces:**
- Consumes: complete `npm run desktop:dev` workflow.
- Produces: verified Windows development launch and cleanup evidence.

- [ ] **Step 1: Run static and automated verification**

Run:

```powershell
npm test
npm run typecheck
npm run build
npm --prefix web run lint
npm --prefix web run build
```

Expected: every command exits 0; root tests include the Electron lifecycle and policy tests.

- [ ] **Step 2: Record existing listeners without killing them**

Run:

```powershell
Get-NetTCPConnection -LocalPort 3000,5173 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalPort,OwningProcess
```

If existing services are present, stop only the exact processes previously started by this Codex task or ask before stopping unknown processes. Never kill by port or name alone.

- [ ] **Step 3: Launch the complete Electron workflow**

Run `npm run desktop:dev` in a visible or controlled background terminal. Verify logs show backend and web readiness, then confirm an Electron window opens to MiniAgent Console.

- [ ] **Step 4: Verify the renderer is connected**

In the Electron window, confirm the header displays engine/version data rather than “后端未连接”, the Run list loads, and selecting a Run enables the Prompt input. Do not send a paid-model prompt merely to validate window wiring.

- [ ] **Step 5: Verify owned-process cleanup**

Close Electron, wait for its cleanup to finish, then run:

```powershell
Get-NetTCPConnection -LocalPort 3000,5173 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalPort,OwningProcess
```

Expected: services started by Electron are gone. Any service that existed before Electron started remains and has the same PID.

- [ ] **Step 6: Update log with observed results**

Use `apply_patch` to replace the provisional verification line in `日志.md` with exact test counts, build results, Electron window observation, and listener cleanup evidence.

- [ ] **Step 7: Run final diff and repository checks**

Run:

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only intentional implementation/log changes remain.

- [ ] **Step 8: Commit verification-only corrections if any**

If Task 4 required corrections, commit only those exact files:

```powershell
git add -- electron/dev-services.mjs electron/window-policy.mjs electron/preload.cjs electron/main.mjs tests/electron-dev-services.test.mjs tests/electron-window-policy.test.mjs package.json package-lock.json 日志.md
git commit -m "fix: verify Electron desktop lifecycle"
```

If no corrections were needed and `日志.md` was already committed with accurate results, do not create an empty commit.
