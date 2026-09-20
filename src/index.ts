import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { createEngineFromEnv } from './agent/engine.js';

const port = Number(process.env.PORT ?? 3000);
const engine = createEngineFromEnv();
const app = createApp({ engine });

const server = serve(
  {
    fetch: app.fetch,
    port,
  },
  (serverInfo) => {
    console.log(
      `MiniAgent server is running at http://localhost:${serverInfo.port}`,
    );
    console.log(
      `Agent engine: ${engine.describe().engine}@${engine.describe().version} (cwd: ${engine.describe().cwd})`,
    );
  },
);

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, closing agent runs...`);
  void engine
    .closeAll()
    .catch((error: unknown) => {
      console.error('Failed to close agent runs:', error);
    })
    .finally(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
