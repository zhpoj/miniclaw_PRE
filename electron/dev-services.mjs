import { execFile, spawn } from 'node:child_process'
import { Socket } from 'node:net'
import { promisify } from 'node:util'

const execFilePromise = promisify(execFile)

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function tcpPortIsOpen({ host, port }, timeoutMs = 750) {
  return new Promise((resolve) => {
    const socket = new Socket()
    let settled = false

    const finish = (open) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(true))
    socket.once('error', (error) => {
      finish(error?.code !== 'ECONNREFUSED')
    })
    socket.connect(port, host)
  })
}

export async function inspectHttpService(service) {
  const portOpen = await tcpPortIsOpen(service)
  if (!portOpen) return 'free'

  try {
    const response = await fetch(service.probeUrl, {
      signal: AbortSignal.timeout(1_000),
    })
    const body = await response.text()
    return service.validateResponse({ response, body }) ? 'ready' : 'occupied'
  } catch {
    return 'occupied'
  }
}

function prefixOutput(stream, name, destination) {
  if (!stream) return
  stream.on('data', (chunk) => {
    const text = String(chunk)
    for (const line of text.split(/(?<=\n)/)) {
      if (line) destination.write(`[${name}] ${line}`)
    }
  })
}

function spawnConfiguredService(service) {
  const child = spawn(service.command, service.args, {
    cwd: service.cwd,
    env: service.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  prefixOutput(child.stdout, service.name, process.stdout)
  prefixOutput(child.stderr, service.name, process.stderr)
  return child
}

export async function killOwnedProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  await execFilePromise('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
  })
}

async function waitUntilReady(service, child, { inspect, sleep, now }) {
  const deadline = now() + service.timeoutMs
  let terminalError

  const onExit = (code) => {
    terminalError = new Error(
      `${service.name} exited before becoming ready (exit code ${code ?? 'unknown'})`,
    )
  }
  const onError = (error) => {
    terminalError = new Error(
      `${service.name} failed to start: ${errorMessage(error)}`,
    )
  }

  child.once('exit', onExit)
  child.once('error', onError)

  try {
    while (true) {
      if (terminalError) throw terminalError
      if (child.exitCode !== null && child.exitCode !== undefined) {
        throw new Error(
          `${service.name} exited before becoming ready (exit code ${child.exitCode})`,
        )
      }

      const status = await inspect(service)
      if (terminalError) throw terminalError
      if (status === 'ready') return
      if (now() >= deadline) {
        throw new Error(
          `${service.name} did not become ready within ${service.timeoutMs}ms`,
        )
      }
      await sleep(service.pollMs)
    }
  } finally {
    child.removeListener('exit', onExit)
    child.removeListener('error', onError)
  }
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
    const owned = states
      .filter((state) => state.owned && state.pid)
      .reverse()
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
          throw new Error(
            `${service.name} port ${service.port} is occupied by an unrecognized service`,
          )
        }

        let child
        try {
          child = spawnService(service)
        } catch (error) {
          throw new Error(
            `${service.name} failed to start: ${errorMessage(error)}`,
          )
        }
        const state = {
          name: service.name,
          owned: true,
          pid: child.pid,
          child,
        }
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
