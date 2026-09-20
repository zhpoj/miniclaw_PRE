import { afterAll, describe, expect, it } from 'vitest';

import { AgentEngine, ENGINE_NAME } from '../src/agent/engine.js';
import { createApp } from '../src/app.js';

const engine = new AgentEngine();
const app = createApp({ engine });

afterAll(async () => {
  await engine.closeAll();
});

describe('agent engine', () => {
  it('reports the pi engine in the agent health endpoint', async () => {
    const response = await app.request('/api/agent/health');

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      engine: { engine: string; version: string };
    };
    expect(body.status).toBe('ok');
    expect(body.engine.engine).toBe(ENGINE_NAME);
    expect(body.engine.version).toEqual(expect.any(String));
  });

  it('creates, lists and closes agent runs', async () => {
    const created = await app.request('/api/agent/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(created.status).toBe(201);
    const run = (await created.json()) as {
      id: string;
      status: string;
      tools: string[];
      cwd: string;
    };
    expect(run.id).toEqual(expect.any(String));
    expect(run.status).toBe('idle');
    expect(run.tools.length).toBeGreaterThan(0);

    const listed = await app.request('/api/agent/runs');
    const ids = ((await listed.json()) as { runs: Array<{ id: string }> }).runs.map(
      (entry) => entry.id,
    );
    expect(ids).toContain(run.id);

    const events = await app.request(`/api/agent/runs/${run.id}/events`);
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toMatchObject({
      run: { id: run.id },
      events: [],
    });

    const deleted = await app.request(`/api/agent/runs/${run.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect((await app.request(`/api/agent/runs/${run.id}`)).status).toBe(404);
  }, 60_000);

  it('rejects unknown runs and invalid payloads', async () => {
    expect((await app.request('/api/agent/runs/does-not-exist')).status).toBe(404);

    const missing = await app.request('/api/agent/runs/does-not-exist/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(missing.status).toBe(404);

    const created = await app.request('/api/agent/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { id } = (await created.json()) as { id: string };

    const invalid = await app.request(`/api/agent/runs/${id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(invalid.status).toBe(400);

    await engine.closeRun(id);
  }, 60_000);

  it('rejects unresolvable models', async () => {
    const created = await app.request('/api/agent/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: '__missing__/__missing__' }),
    });

    expect(created.status).toBe(400);
    await expect(created.json()).resolves.toMatchObject({
      error: 'model_unresolved',
    });
  }, 60_000);
});
