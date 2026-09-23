# Electron 开发壳设计

日期：2026-09-23

## 目标

为现有 MiniClaw 项目增加一个 Windows Electron 开发入口。开发者执行一次 `npm run desktop:dev` 后，Electron 自动启动 MiniClaw 后端、Vite 前端，并在桌面窗口中打开现有 React 客户端。

本阶段只完成：

1. Electron 桌面窗口复用当前 `web/` 客户端。
2. Electron 自动管理后端与 Vite 开发服务器的启动和退出。

## 非目标

本阶段不包含：

- Windows 安装包、代码签名或自动更新。
- 托盘菜单、开机自启或后台常驻。
- 客户端视觉重构。
- 将 Agent 后端嵌入 Electron 主进程。
- 生产环境静态资源加载方案。
- 新增任意文件系统、Shell 或进程执行 IPC 能力。

## 方案选择

采用“Electron 分别管理后端和 Vite 子进程”的方式。

不复用现有 `run-dev.mjs` 作为唯一子进程，因为 Electron 需要分别判断后端和前端是否就绪、报告具体启动错误，并在退出时只清理由自己启动的进程。

暂不把 Agent 后端直接放进 Electron 主进程，以免 Agent 或飞书长连接异常影响桌面窗口生命周期。后续制作安装包时，再评估将编译后的后端作为 Electron Utility Process 运行。

## 运行结构

```text
npm run desktop:dev
  └─ Electron 主进程
      ├─ 检查 http://127.0.0.1:3000/api/agent/health
      ├─ 必要时启动 MiniClaw 后端
      ├─ 检查 http://127.0.0.1:5173
      ├─ 必要时启动 Vite 前端
      ├─ 等待两个服务就绪
      └─ 创建 BrowserWindow 并加载 http://127.0.0.1:5173
```

后端继续使用现有入口：

```text
node --env-file=.env --import tsx src/index.ts
```

前端继续使用现有入口：

```text
npm --prefix web run dev -- --host 127.0.0.1
```

## 文件结构

新增：

- `electron/main.mjs`：Electron 应用与窗口生命周期。
- `electron/preload.cjs`：最小 preload；本阶段不暴露高权限 API。
- `electron/dev-services.mjs`：服务探测、启动、就绪等待和关闭。
- `tests/electron-dev-services.test.ts`：进程管理行为测试。

修改：

- `package.json`：增加 Electron 开发依赖和 `desktop:dev` 命令。
- `package-lock.json`：锁定新增依赖。
- `.gitignore`：忽略 Electron 开发运行日志（如需要新增专用目录）。
- `日志.md`：记录 Electron 接入。

## 启动生命周期

1. Electron 启动后先探测后端健康接口。
2. 若健康接口返回预期 MiniClaw 数据，视为已有正确后端并复用，不重复启动。
3. 若端口未监听，Electron 启动后端并轮询健康接口。
4. 若端口已占用但不是可识别的 MiniClaw 后端，启动失败并显示明确错误，不结束占用端口的程序。
5. 后端就绪后，以相同规则检查 Vite 前端。
6. 两个服务均就绪后才创建并展示桌面窗口，避免用户看到连接失败的半成品页面。
7. 任一步骤失败时，停止本次启动过程中已经创建的所有子进程，并显示具体失败原因。

启动等待必须有超时，避免 Electron 永久停在无窗口状态。错误信息至少区分：命令无法执行、进程提前退出、端口被未知程序占用和服务就绪超时。

## 关闭生命周期

进程管理器记录每个服务是否由本次 Electron 会话启动：

- Electron 启动的进程：应用退出时关闭其完整进程树。
- 启动前已经存在并被复用的服务：应用退出时不关闭。

Windows 下仅对进程管理器亲自创建并记录的 PID 执行进程树关闭，不按进程名称或端口批量结束程序。

关闭流程可重复执行，窗口关闭、Electron `before-quit` 和启动失败清理不会导致重复异常。

## 窗口与安全

`BrowserWindow` 使用：

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- 明确的 preload 文件

preload 本阶段只暴露无权限的只读桌面标记或完全不暴露 API。不得向 React 页面暴露 `ipcRenderer`、Node.js、文件系统、Shell 或任意命令执行能力。

窗口只加载本地 Vite 地址。阻止页面导航到非本地来源，并使用系统浏览器打开经过校验的外部 HTTPS 链接。

## 开发体验

根目录新增命令：

```powershell
npm run desktop:dev
```

命令在同一终端输出带 `[backend]`、`[web]` 和 `[electron]` 前缀的日志。关闭 Electron 窗口或在终端按 `Ctrl+C` 时，执行同一套清理流程。

现有命令保持不变：

- `npm run dev`：只启动后端。
- `npm run dev:full`：启动浏览器开发环境。
- `npm run desktop:dev`：启动后端、前端和 Electron。

## 测试与验收

自动化测试覆盖：

- 正确服务已存在时复用且退出时不关闭。
- 端口空闲时启动服务并等待就绪。
- 端口被未知服务占用时拒绝继续。
- 子进程提前退出时返回可理解错误。
- 启动超时后关闭本次已启动的进程。
- 多次清理不会重复终止或抛错。

手工验收：

1. 在后端和前端均未运行时执行 `npm run desktop:dev`。
2. 自动出现 Electron 窗口并显示现有 MiniAgent Console。
3. 页面能读取健康状态、列出 Run 并发送 Prompt。
4. 飞书长连接随同后端正常建立。
5. 关闭 Electron 后，由 Electron 启动的 3000/5173 服务不再监听。
6. 预先手动启动正确后端后再次启动 Electron，Electron 复用后端且退出时不关闭它。

## 后续演进

完成本设计后，下一阶段可以独立推进：

- 将调试控制台重构为聊天优先的桌面客户端。
- 使用编译产物替代 Vite 与 `tsx`，制作正式 Windows 安装包。
- 将后端迁移到 Electron Utility Process。
- 增加经过权限收敛的文件选择、通知和托盘能力。
