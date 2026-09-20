import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

import { AgentEngine, createEngineFromEnv, ENGINE_NAME } from './agent/engine.js';
import { AgentEngineError } from './agent/run.js';

const createRunSchema = z.object({
  cwd: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinkingLevel: z
    .enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    .optional(),
  tools: z.array(z.string().min(1)).optional(),
  systemPrompt: z.string().min(1).optional(),
  persistSession: z.boolean().optional(),
});

const promptSchema = z.object({
  text: z.string().min(1),
  streamingBehavior: z.enum(['steer', 'followUp']).optional(),
});

const sinceSchema = z.coerce.number().int().min(0).default(0);

export interface CreateAppOptions {
  engine?: AgentEngine;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono();
  const engine = options.engine ?? createEngineFromEnv();

  app.get('/api/health', (context) => {
    return context.json({
      status: 'ok',
    });
  });

  app.get('/api/agent/health', (context) => {
    return context.json({
      status: 'ok',
      engine: engine.describe(),
    });
  });

  app.post('/api/agent/runs', async (context) => {
    const body = await context.req.json().catch(() => undefined);
    const parsed = createRunSchema.safeParse(body ?? {});

    if (!parsed.success) {
      return context.json(
        {
          error: 'invalid_request',
          message: 'Invalid run payload.',
          issues: z.treeifyError(parsed.error),
        },
        400,
      );
    }

    try {
      const run = await engine.createRun(parsed.data);
      return context.json(run.snapshot(), 201);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.get('/api/agent/runs', (context) => {
    return context.json({
      runs: engine.listRuns().map((run) => run.snapshot()),
    });
  });

  app.get('/api/agent/runs/:id', (context) => {
    const run = engine.getRun(context.req.param('id'));
    if (!run) {
      return context.json({ error: 'run_not_found', message: 'Unknown agent run.' }, 404);
    }
    return context.json(run.snapshot());
  });

  app.get('/api/agent/runs/:id/events', (context) => {
    const run = engine.getRun(context.req.param('id'));
    if (!run) {
      return context.json({ error: 'run_not_found', message: 'Unknown agent run.' }, 404);
    }
    const since = sinceSchema.safeParse(context.req.query('since') ?? 0);
    return context.json({
      run: run.snapshot(),
      events: run.eventsSince(since.success ? since.data : 0),
    });
  });

  app.get('/api/agent/runs/:id/stream', (context) => {
    const run = engine.getRun(context.req.param('id'));
    if (!run) {
      return context.json({ error: 'run_not_found', message: 'Unknown agent run.' }, 404);
    }
    const since = sinceSchema.safeParse(context.req.query('since') ?? 0);
    const startSeq = since.success ? since.data : 0;

    return streamSSE(context, async (stream) => {
      const done = new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });

      const unsubscribe = run.subscribe((event) => {
        void stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        });
      });

      try {
        await stream.writeSSE({
          event: 'run',
          data: JSON.stringify(run.snapshot()),
        });
        for (const event of run.eventsSince(startSeq)) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
        }
        await done;
      } finally {
        unsubscribe();
      }
    });
  });

  app.post('/api/agent/runs/:id/prompt', async (context) => {
    const run = engine.getRun(context.req.param('id'));
    if (!run) {
      return context.json({ error: 'run_not_found', message: 'Unknown agent run.' }, 404);
    }

    const body = await context.req.json().catch(() => undefined);
    const parsed = promptSchema.safeParse(body);

    if (!parsed.success) {
      return context.json(
        {
          error: 'invalid_request',
          message: 'Invalid prompt payload.',
          issues: z.treeifyError(parsed.error),
        },
        400,
      );
    }

    try {
      const result = await run.prompt(parsed.data.text, {
        ...(parsed.data.streamingBehavior
          ? { streamingBehavior: parsed.data.streamingBehavior }
          : {}),
      });
      return context.json({ id: run.id, ...result }, 202);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.post('/api/agent/runs/:id/abort', async (context) => {
    const run = engine.getRun(context.req.param('id'));
    if (!run) {
      return context.json({ error: 'run_not_found', message: 'Unknown agent run.' }, 404);
    }
    await run.abort();
    return context.json(run.snapshot());
  });

  app.delete('/api/agent/runs/:id', async (context) => {
    const id = context.req.param('id');
    const run = await engine.closeRun(id);
    if (!run) {
      return context.json({ error: 'run_not_found', message: 'Unknown agent run.' }, 404);
    }
    return context.json({ id, closed: true });
  });

  return app;
}

function errorResponse(
  context: Context,
  error: unknown,
): Response {
  if (error instanceof AgentEngineError) {
    return context.json(
      { error: error.code, message: error.message },
      error.status as ContentfulStatusCode,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return context.json(
    { error: 'engine_error', message: `${ENGINE_NAME} failed: ${message}` },
    500,
  );
}
