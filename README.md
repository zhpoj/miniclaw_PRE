# MiniAgent (miniclaw_PRE)

> A self-hosted AI coding-agent runtime & service platform — Hono HTTP API (REST + SSE), a `pi-coding-agent` engine wrapper with approval flow, Feishu/Lark IM channel, SQLite persistence, React/Vite web UI and Electron desktop client.

> 一个自托管的 AI 编程智能体运行与服务平台：基于 Hono 的 HTTP 服务（REST + SSE 流式）、对 `pi-coding-agent` 的引擎封装（含审批流）、飞书/Lark 渠道接入、SQLite 持久化，并提供 React/Vite 前端与 Electron 桌面端。

---

## ✨ Features / 特性

- **Agent engine on top of `pi-coding-agent`** — manages model runtime, tool allowlists, host/container execution modes, and per-run workspaces.
  基于 `pi-coding-agent` 的引擎封装，统一管理模型运行时、工具白名单、host/container 执行模式与按任务隔离的工作区。
- **Streaming HTTP API** — create/prompt/abort agent runs over REST, with Server-Sent Events (`/stream`) for live token & event streaming.
  流式 HTTP 接口：通过 REST 创建/对话/中止任务，并用 SSE 实时推送 token 与事件。
- **Human-in-the-loop approvals** — pending tool-call approvals are exposed via API; clients heartbeat and decide `allow_once` / `allow_turn` / `deny`.
  人在环审批：待审批的工具调用通过 API 暴露，客户端可心跳保活并裁决 `allow_once` / `allow_turn` / `deny`。
- **Feishu / Lark channel** — a thin `IMChannel` contract with WebSocket (default) or HTTP webhook transport, signature verification (HMAC-SHA256) + AES payload decryption, and card-message streaming replies. One conversation = one agent run.
  飞书/Lark 渠道：一层很薄的 `IMChannel` 契约，支持官方长连接（默认）或 HTTP 回调，含签名校验（HMAC-SHA256）与 AES 解密，并以卡片消息流式回复。一个会话对应一个 agent 任务。
- **Durable state (SQLite/WAL)** — messages, usage accounting, scheduled tasks and memories persist to `data/db/messages.db` with WAL enabled.
  SQLite 持久化（WAL）：消息、用量统计、调度任务与记忆落盘到 `data/db/messages.db`。
- **Scheduler & memory modules** — background task scheduling (`src/scheduler`) and a memory store (`src/memory`) shared across runs.
  调度与记忆模块：后台任务调度（`src/scheduler`）与跨任务共享的记忆存储（`src/memory`）。
- **Web UI + Desktop** — React + Vite frontend (`web/`, :5173) and an Electron desktop shell (`electron/`).
  Web 前端与桌面端：React + Vite 前端（`web/`，:5173）与 Electron 桌面壳（`electron/`）。
- **One-command dev & Docker** — `npm run dev:full` boots server + web together; multi-stage `Dockerfile` + `docker-compose.yml` for production.
  一键开发与容器化：`npm run dev:full` 同时拉起后端与前端；多阶段 `Dockerfile` + `docker-compose.yml` 用于生产部署。

---

## 🚀 Quick Start / 快速开始

### Option A — Docker (recommended) / 容器部署（推荐）

```bash
# 1. 准备环境变量（可选，至少配一个模型提供方密钥）
cp .env.example .env
# 编辑 .env：设置 WORKSPACE_PATH 与模型鉴权（见下方配置）

# 2. 构建并启动
docker compose up -d --build

# 3. 健康检查
curl http://localhost:3000/api/health
```

服务默认监听 `:3000`，agent 工作区挂载为容器内 `/workspace`（由 `.env` 的 `WORKSPACE_PATH` 决定）。

### Option B — Local (Node 22+) / 本地运行

```bash
# 安装依赖
npm install

# 配置环境变量（模型鉴权、工作区等）
cp .env.example .env

# 同时启动后端(:3000) 与前端(:5173)
npm run dev:full
# 仅后端（tsx watch）
npm run dev
```

浏览器打开 `http://localhost:5173` 即可使用聊天工作台。

---

## ⚙️ Configuration / 配置项

复制 `.env.example` 为 `.env` 后生效。常用变量：

| Variable / 变量 | Default | Description / 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 监听端口 |
| `AGENT_CWD` | — | agent 默认工作目录（容器内/绝对路径） |
| `AGENT_WORKSPACE_HOST` | — | 宿主机侧工作区，映射为容器内路径 |
| `AGENT_EXEC_MODE` | 自动 | `host` 或 `container` 执行模式 |
| `AGENT_TOOLS` | 按平台 | 工具白名单，逗号分隔，如 `read,bash,edit,write` |
| `AGENT_MODEL` | — | 默认模型，如 `anthropic/claude-sonnet-4-5` |
| `AGENT_PERSIST_SESSIONS` | `0` | 设为 `1` 将会话落盘 |
| `AGENT_ALLOW_MODEL_NETWORK` | `0` | 设为 `1` 允许联网拉取模型目录 |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` | — | 模型提供方鉴权 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | — | 飞书自建应用凭证（配置后自动挂载渠道） |
| `FEISHU_ENCRYPT_KEY` | — | 启用签名校验与事件解密；不配则跳过 |
| `FEISHU_RECEIVE_ID_TYPE` | `chat_id` | 发送地址类型：`chat_id` / `open_id` |
| `FEISHU_CONNECTION_MODE` | `websocket` | `websocket`（默认，无需公网）或 `webhook` |
| `FEISHU_BASE_URL` | `https://open.feishu.cn` | 飞书开放平台地址 |
| `IM_TURN_TIMEOUT_MS` | `600000` | 单任务超时（`0` = 不限制） |
| `IM_MAX_QUEUE` | `3` | 执行中最多排队的消息数 |
| `IM_MAX_CONVERSATIONS` | `50` | 同时保留的会话数 |
| `IM_MAX_REPLY_CHARS` | `4000` | 单条回复最大字数（超出截断） |
| `IM_STREAMING` | `0` | 设为 `1` 以卡片形式流式更新回复 |

> 仅当 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 存在时，飞书渠道才会挂载；否则服务照常启动且无 IM 通道。

---

## 🗂️ Project Structure / 目录结构

```
miniclaw_PRE/
├── src/
│   ├── agent/         # 引擎封装：engine、run、approval、workspace
│   ├── im/            # IM 渠道层：IMChannel 契约、Feishu、bridge
│   ├── memory/        # 跨任务记忆存储
│   ├── scheduler/     # 后台任务调度
│   ├── storage/       # SQLite（WAL）、用量与可靠性
│   ├── app.ts         # Hono 路由与 API
│   ├── index.ts       # 服务入口
│   └── server-config.ts
├── web/               # React + Vite 前端（:5173）
├── electron/          # Electron 桌面壳
├── tests/             # 单元测试（vitest）
├── docs/superpowers/  # 规格与计划
├── Dockerfile         # 多阶段镜像
├── docker-compose.yml # 生产编排
├── run-dev.mjs        # 一键开发（后端+前端）
└── .env.example       # 配置模板
```

---

## 🔌 HTTP API (摘要) / API Summary

Base URL: `http://localhost:3000`

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/health` | 存活检查 |
| GET | `/api/agent/health` | 引擎信息 |
| POST | `/api/agent/runs` | 创建 agent 任务 |
| GET | `/api/agent/runs` | 列出任务 |
| GET | `/api/agent/runs/:id` | 任务快照 |
| GET | `/api/agent/runs/:id/events?since=` | 拉取事件 |
| GET | `/api/agent/runs/:id/stream` | SSE 实时流 |
| POST | `/api/agent/runs/:id/prompt` | 发送对话 |
| POST | `/api/agent/runs/:id/abort` | 中止任务 |
| DELETE | `/api/agent/runs/:id` | 关闭任务 |
| GET | `/api/agent/approvals` | 待审批列表 |
| POST | `/api/agent/approvals/:id/decision` | 审批裁决 |
| POST | `/api/agent/approval-clients/heartbeat` | 审批客户端心跳 |
| GET | `/api/im/health` | IM 渠道状态 |
| GET | `/api/im/conversations` | 会话列表（启用 IM 时） |
| POST | `/api/im/feishu/webhook` | 飞书回调（webhook 模式） |

---

## 💬 Feishu / Lark Integration / 飞书接入

1. 在飞书开放平台创建**自建应用**，获取 `App ID` / `App Secret`，按需配置 `Encrypt Key`。
2. 在 `.env` 中填写 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_ENCRYPT_KEY`。
3. 默认使用官方**长连接**（WebSocket），无需公网地址；如需 HTTP 回调则设 `FEISHU_CONNECTION_MODE=webhook`，并把 `https://<你的域名>/api/im/feishu/webhook` 填到飞书后台的事件订阅 URL。
4. 启动后，飞书消息会被转发为对应会话的 agent 任务，回复以卡片消息流式返回。

---

## 🧪 Development & Testing / 开发与测试

```bash
npm run dev:full     # 后端(:3000) + 前端(:5173)
npm run typecheck    # 类型检查
npm run build        # 编译到 dist/
npm test             # 运行所有单元测试 (vitest)
npm run docker:build # 构建 Docker 镜像
```

测试覆盖：根项目与前端均有 vitest 套件（设计 QA 记录显示根项目 65/65、前端 5/5 通过）。

---

## 📦 Docker / 容器

```bash
docker build -t miniclaw:latest .
docker run -p 3000:3000 \
  -e AGENT_ALLOW_MODEL_NETWORK=1 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v "$PWD/workspace:/workspace" \
  miniclaw:latest
```

镜像以非 root 用户（`miniclaw`）运行，内置健康检查，适合直接 `docker compose up`。

---

## 📄 License / 许可

目前仓库未包含 `LICENSE` 文件；`package.json` 标注为 **ISC**。如需公开发布，建议补充一份 `LICENSE` 文本。

---

<p align="center">
  MiniAgent · Self-hosted AI coding-agent platform · Hono + pi-coding-agent + Feishu
</p>
