/**
 * 一键启动开发环境：同时拉起后端（根目录 `npm run dev`，:3000）和
 * 前端（web/ `npm run dev`，:5173）。Ctrl+C 会一并终止两者。
 *
 * 用法：在仓库根目录执行 `npm run dev:full`（或 `node run-dev.mjs`）。
 */
import { spawn } from 'node:child_process'

const jobs = [
  { label: 'server', args: ['run', 'dev'] }, // 根目录：后端 + tsx watch
  { label: 'web', args: ['--prefix', 'web', 'run', 'dev'] }, // 前端 Vite
]

console.log(
  '\x1b[32m▶ MiniAgent 开发环境启动中：后端 http://localhost:3000 + 前端 http://localhost:5173（Ctrl+C 退出）\x1b[0m',
)

const children = jobs.map((job) =>
  spawn('npm', job.args, { shell: true, stdio: 'inherit' }),
)

function shutdown() {
  for (const child of children) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已退出 */
    }
  }
  setTimeout(() => process.exit(0), 300).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
