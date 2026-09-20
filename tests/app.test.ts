import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';

describe('GET /api/health', () => {
  it('returns the service health status', async () => {
    const app = createApp();

    const response = await app.request('/api/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
    });
  });
});