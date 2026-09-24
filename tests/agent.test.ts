import { afterAll, describe, expect, it, vi } from 'vitest';

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

  it('registers desktop approval presence and validates client IDs', async () => {
    const heartbeat = await app.request('/api/agent/approval-clients/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'desktop-test' }),
    });

    expect(heartbeat.status).toBe(200);
    await expect(heartbeat.json()).resolves.toEqual({ active: true });

    const invalid = await app.request('/api/agent/approval-clients/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: '' }),
    });
    expect(invalid.status).toBe(400);
  });

  it('lists and resolves pending approvals with stable error statuses', async () => {
    const approvals = engine.getApprovalManager();
    approvals.heartbeat('desktop-test');
    approvals.beginTurn('api-run', 'api-turn', 'desktop');
    const outcome = approvals.request({
      runId: 'api-run',
      turnId: 'api-turn',
      source: 'desktop',
      cwd: 'F:\\project',
      toolName: 'write',
      input: { path: 'src/a.ts', content: 'hello' },
    });
    const approvalId = approvals.listPending('api-run')[0]!.id;

    const listed = await app.request('/api/agent/approvals?runId=api-run&status=pending');
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      approvals: [{ id: approvalId, status: 'pending' }],
    });

    const decided = await app.request(`/api/agent/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow_turn' }),
    });
    expect(decided.status).toBe(200);
    await expect(decided.json()).resolves.toMatchObject({ id: approvalId, status: 'allowed' });
    await expect(outcome).resolves.toEqual({ allowed: true, scope: 'turn' });

    const duplicate = await app.request(`/api/agent/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow_once' }),
    });
    expect(duplicate.status).toBe(409);

    const missing = await app.request('/api/agent/approvals/missing/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'deny' }),
    });
    expect(missing.status).toBe(404);

    const invalid = await app.request(`/api/agent/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'always_allow' }),
    });
    expect(invalid.status).toBe(400);
    approvals.endTurn('api-run', 'test cleanup');
  });

  it('passes the desktop source from the HTTP prompt to the run', async () => {
    const run = await engine.createRun();
    const prompt = vi.spyOn(run, 'prompt').mockResolvedValue({
      accepted: true,
      mode: 'started',
    });

    const response = await app.request(`/api/agent/runs/${run.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', source: 'desktop' }),
    });

    expect(response.status).toBe(202);
    expect(prompt).toHaveBeenCalledWith('hello', { source: 'desktop' });
    await engine.closeRun(run.id);
  }, 60_000);
});
