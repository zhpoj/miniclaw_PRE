import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'

import { createDevServiceManager } from './dev-services.mjs'
import { pickDirectory } from './folder-picker.mjs'
import { classifyNavigation, createWindowOptions } from './window-policy.mjs'

const frontendOrigin = 'http://127.0.0.1:5173'
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const preloadPath = fileURLToPath(new URL('./preload.cjs', import.meta.url))
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const services = [
  {
    name: 'backend',
    host: '127.0.0.1',
    port: 3000,
    probeUrl: 'http://127.0.0.1:3000/api/agent/health',
    validateResponse: ({ response, body }) =>
      response.ok && body.includes('"engine"'),
    command: 'node',
    args: ['--env-file=.env', '--import', 'tsx', 'src/index.ts'],
    cwd: projectRoot,
    env: process.env,
    timeoutMs: 30_000,
    pollMs: 200,
  },
  {
    name: 'web',
    host: '127.0.0.1',
    port: 5173,
    probeUrl: `${frontendOrigin}/`,
    validateResponse: ({ response, body }) =>
      response.ok && body.includes('<div id="root"></div>'),
    command: npmCommand,
    args: ['--prefix', 'web', 'run', 'dev', '--', '--host', '127.0.0.1'],
    cwd: projectRoot,
    env: process.env,
    timeoutMs: 30_000,
    pollMs: 200,
  },
]

const manager = createDevServiceManager({ services })
let mainWindow
let quitStarted = false
let cleanupComplete = false

ipcMain.handle('desktop:select-directory', async (event, defaultPath) => {
  const window = mainWindow
  if (!window || event.sender !== window.webContents) return null
  return pickDirectory({
    showOpenDialog: dialog.showOpenDialog,
    owner: window,
    defaultPath,
  })
})

function openExternalIfAllowed(targetUrl) {
  if (classifyNavigation(targetUrl, frontendOrigin) === 'external') {
    void shell.openExternal(targetUrl)
  }
}

async function createMainWindow() {
  const window = new BrowserWindow(createWindowOptions(preloadPath))
  mainWindow = window

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  window.webContents.on('will-navigate', (event, targetUrl) => {
    const decision = classifyNavigation(targetUrl, frontendOrigin)
    if (decision === 'allow') return
    event.preventDefault()
    if (decision === 'external') openExternalIfAllowed(targetUrl)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url)
    return { action: 'deny' }
  })

  await window.loadURL(frontendOrigin)
}

app.on('before-quit', (event) => {
  if (cleanupComplete) return
  event.preventDefault()
  if (quitStarted) return
  quitStarted = true

  void manager.stopAll().finally(() => {
    cleanupComplete = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

process.on('SIGINT', () => app.quit())
process.on('SIGTERM', () => app.quit())

app.whenReady().then(async () => {
  try {
    const states = await manager.startAll()
    for (const state of states) {
      console.log(
        `[electron] ${state.name}: ${state.owned ? `started (pid ${state.pid})` : 'reused'}`,
      )
    }
    await createMainWindow()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await manager.stopAll()
    cleanupComplete = true
    dialog.showErrorBox('MiniClaw 启动失败', message)
    app.quit()
  }
})
