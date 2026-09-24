export interface ServerListenOptions {
  hostname: '127.0.0.1';
  port: number;
}

/** Approval routes are unauthenticated and therefore must remain loopback-only. */
export function createServerListenOptions(port: number): ServerListenOptions {
  return { hostname: '127.0.0.1', port };
}
