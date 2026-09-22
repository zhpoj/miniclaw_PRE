# MiniAgent Console (React + TypeScript + Vite)

前端控制台，对接后端 MiniAgent HTTP API 的 `runs` / `prompt` / `events` 三个接口：

| 面板 | 接口 |
| --- | --- |
| Runs 列表 / 新建 run | `GET`、`POST /api/agent/runs` |
| Prompt 输入区 | `POST /api/agent/runs/:id/prompt` |
| Events 流 | `GET /api/agent/runs/:id/events?since=<seq>` |
| 顶部状态条 | `GET /api/agent/health` |

运行方式：先启动后端（`npm run dev`，默认 `http://localhost:3000`），再在本目录执行 `npm run dev`（默认 `http://localhost:5173`）。
Vite 已配置 `/api` 代理转发到后端；若后端端口不同，用环境变量覆盖：`API_TARGET=http://localhost:4000 npm run dev`。

Events 采用轮询增量拉取：`since = 最后一条事件 seq + 1`，每 1.5s 一次（可用顶部开关关闭），旧事件合并去重并只保留最近 500 条用于渲染。

## 原始模板说明

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```

You can also install [eslint-plugin-react-x](https://npmx.dev/package/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://npmx.dev/package/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```
