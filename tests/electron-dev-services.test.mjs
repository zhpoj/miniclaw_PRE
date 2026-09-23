import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import {
  createDevServiceManager,
  spawnConfiguredService,
} from '../electron/dev-services.mjs'

function child(pid = 41) {
  const emitter = new EventEmitter()
  return Object.assign(emitter, { pid, exitCode: null })
}

const backend = {
  name: 'backend',
  host: '127.0.0.1',
  port: 3000,
  probeUrl: 'http://127.0.0.1:3000/api/agent/health',
  validateResponse: () => true,
  command: 'node',
  args: ['dist/index.js'],
  cwd: 'F:/repo',
  env: {},
  timeoutMs: 100,
  pollMs: 1,
}

describe('Electron development service manager', () => {
  it('runs a Windows command shim through cmd.exe without enabling shell mode', () => {
    const spawned = child(91)
    const spawnImpl = vi.fn(() => spawned)
    const service = { ...backend, command: 'npm.cmd', args: ['--version'] }

    const result = spawnConfiguredService(service, {
      spawnImpl,
      platform: 'win32',
      commandShell: 'C:\\Windows\\System32\\cmd.exe',
    })

    expect(result).toBe(spawned)
    expect(spawnImpl).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'npm.cmd', '--version'],
      expect.objectContaining({ shell: false, windowsHide: true }),
    )
  })

  it('reuses a recognized service and never kills it', async () => {
    const spawnService = vi.fn()
    const killTree = vi.fn()
    const manager = createDevServiceManager({
      services: [backend],
      inspect: vi.fn().mockResolvedValue('ready'),
      spawnService,
      killTree,
      sleep: vi.fn(),
      now: vi.fn(() => 0),
    })

    await expect(manager.startAll()).resolves.toMatchObject([
      { name: 'backend', owned: false },
    ])
    await manager.stopAll()

    expect(spawnService).not.toHaveBeenCalled()
    expect(killTree).not.toHaveBeenCalled()
  })

  it('rejects an occupied unknown endpoint without spawning or killing', async () => {
    const spawnService = vi.fn()
    const killTree = vi.fn()
    const manager = createDevServiceManager({
      services: [backend],
      inspect: vi.fn().mockResolvedValue('occupied'),
      spawnService,
      killTree,
      sleep: vi.fn(),
      now: vi.fn(() => 0),
    })

    await expect(manager.startAll()).rejects.toThrow(
      'backend port 3000 is occupied',
    )
    expect(spawnService).not.toHaveBeenCalled()
    expect(killTree).not.toHaveBeenCalled()
  })

  it('starts a free service, waits for readiness, and kills its tree once', async () => {
    const spawned = child()
    const inspect = vi
      .fn()
      .mockResolvedValueOnce('free')
      .mockResolvedValueOnce('free')
      .mockResolvedValue('ready')
    const killTree = vi.fn().mockResolvedValue(undefined)
    const manager = createDevServiceManager({
      services: [backend],
      inspect,
      spawnService: vi.fn(() => spawned),
      killTree,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: vi.fn(() => 0),
    })

    await expect(manager.startAll()).resolves.toMatchObject([
      { name: 'backend', owned: true, pid: 41 },
    ])
    await manager.stopAll()
    await manager.stopAll()

    expect(killTree).toHaveBeenCalledTimes(1)
    expect(killTree).toHaveBeenCalledWith(41)
  })

  it('fails immediately when a child exits before readiness', async () => {
    const spawned = child()
    const inspect = vi
      .fn()
      .mockResolvedValueOnce('free')
      .mockImplementation(async () => {
        spawned.exitCode = 1
        spawned.emit('exit', 1)
        return 'free'
      })
    const manager = createDevServiceManager({
      services: [backend],
      inspect,
      spawnService: vi.fn(() => spawned),
      killTree: vi.fn(),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: vi.fn(() => 0),
    })

    await expect(manager.startAll()).rejects.toThrow(
      'backend exited before becoming ready',
    )
  })

  it('reports a child process startup error before readiness', async () => {
    const spawned = child()
    const inspect = vi
      .fn()
      .mockResolvedValueOnce('free')
      .mockImplementation(async () => {
        spawned.emit('error', new Error('spawn node ENOENT'))
        return 'free'
      })
    const manager = createDevServiceManager({
      services: [backend],
      inspect,
      spawnService: vi.fn(() => spawned),
      killTree: vi.fn().mockResolvedValue(undefined),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: vi.fn(() => 0),
    })

    await expect(manager.startAll()).rejects.toThrow(
      'backend failed to start: spawn node ENOENT',
    )
  })

  it('cleans an earlier owned service when a later service times out', async () => {
    const frontend = {
      ...backend,
      name: 'web',
      port: 5173,
      probeUrl: 'http://127.0.0.1:5173',
      timeoutMs: 2,
    }
    const children = [child(41), child(42)]
    let clock = 0
    const inspect = vi.fn(async (service) =>
      service.name === 'backend' && clock > 0 ? 'ready' : 'free',
    )
    const killTree = vi.fn().mockResolvedValue(undefined)
    const manager = createDevServiceManager({
      services: [backend, frontend],
      inspect,
      spawnService: vi.fn(() => children.shift()),
      killTree,
      sleep: vi.fn(async () => {
        clock += 2
      }),
      now: vi.fn(() => clock),
    })

    await expect(manager.startAll()).rejects.toThrow('web did not become ready')
    expect(killTree).toHaveBeenCalledWith(41)
    expect(killTree).toHaveBeenCalledWith(42)
  })
})
