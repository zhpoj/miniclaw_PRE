import { serve } from '@hono/node-server';

import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

serve(
  {
    fetch: app.fetch,
    port,
  },
  (serverInfo) => {
    console.log(
      `MiniAgent server is running at http://localhost:${serverInfo.port}`,
    );
  },
);