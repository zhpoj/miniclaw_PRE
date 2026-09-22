# Workspace

这个目录是 agent 的默认操作区（容器内路径 `/workspace`）。

- 容器内由 `AGENT_CWD=/workspace` 指定，宿主机目录通过 compose 挂载进来
- 想让 agent 操作别的项目：改 `docker-compose.yml` 里的 `- <你的项目绝对路径>:/workspace`
- 也可以在创建 run 时临时切换目录：`POST /api/agent/runs` body 里传 `{"cwd": "/workspace/某个子目录"}`
- 该目录是数据而非代码，已在 `.dockerignore` 中排除
