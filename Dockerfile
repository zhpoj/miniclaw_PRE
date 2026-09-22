# ---------- deps ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---------- runtime ----------
# pi 的 shell 工具需要 bash；git/rg/fd 供项目检索类工具使用
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash git ripgrep fd-find tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1001 --shell /bin/bash miniclaw \
  && mkdir -p /workspace \
  && chown -R miniclaw:miniclaw /workspace

WORKDIR /app
COPY --from=build --chown=miniclaw:miniclaw /app/node_modules ./node_modules
COPY --from=build --chown=miniclaw:miniclaw /app/dist ./dist
COPY --chown=miniclaw:miniclaw package.json ./

ENV NODE_ENV=production \
  PORT=3000 \
  AGENT_EXEC_MODE=container \
  AGENT_CWD=/workspace \
  AGENT_ALLOW_MODEL_NETWORK=1 \
  HOME=/home/miniclaw

USER miniclaw
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
