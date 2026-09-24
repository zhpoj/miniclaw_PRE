import { describe, expect, it } from 'vitest';

import { createServerListenOptions } from '../src/server-config.js';

describe('createServerListenOptions', () => {
  it('binds the unauthenticated approval API to loopback only', () => {
    expect(createServerListenOptions(3000)).toEqual({
      hostname: '127.0.0.1',
      port: 3000,
    });
  });
});
