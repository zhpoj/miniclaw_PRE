import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { createEngineFromEnv } from './agent/engine.js';
import { getMountedIM, startMountedIM, stopMountedIM } from './im/index.js';
import { createServerListenOptions } from './server-config.js';
import { SqliteStore } from './storage/sqlite.js';

const port = Number(process.env.PORT ?? 3000);
const engine = createEngineFromEnv();
const store = new SqliteStore();
const app = createApp({ engine, store });
const im = getMountedIM(app);

const info = engine.describe();

const server = serve(
  {
    fetch: app.fetch,
    ...createServerListenOptions(port),
  },
  (serverInfo) => {
    console.log(
      `MiniAgent server is running at http://localhost:${serverInfo.port}`,
    );
    console.log(
      `Agent engine: ${info.engine}@${info.version} (mode: ${info.mode}, cwd: ${info.cwd})`,
    );
    if (info.workspace.hostPath) {
      console.log(`Workspace: host ${info.workspace.hostPath} -> ${info.workspace.containerPath}`);
    }
    if (!info.workspace.exists) {
      console.warn(
        `[warn] workspace directory does not exist: ${info.cwd} (set AGENT_CWD / AGENT_WORKSPACE_HOST to a real directory)`,
      );
    }
    const channels = im?.channels ?? [];
    if (channels.length === 0) {
      console.log('IM channels: none configured (set FEISHU_APP_ID / FEISHU_APP_SECRET to enable)');
    } else {
      console.log(`IM channels: ${channels.map((channel) => channel.id).join(', ')}`);
      console.log(
        `IM webhook: ${channels.map((channel) => `/api/im/${channel.id}/webhook`).join(', ')}`,
      );
    }
  },
);

void startMountedIM(im)
  .then(() => {
    if ((im?.channels.length ?? 0) > 0) console.log('IM transports: started');
  })
  .catch((error: unknown) => {
    console.error('Failed to start IM transports:', error);
  });

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, closing agent runs...`);
  void engine
    .closeAll()
    .then(() => stopMountedIM(im))
    .catch((error: unknown) => {
      console.error('Failed to close agent runs:', error);
    })
    .finally(() => {
      store.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
