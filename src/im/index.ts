import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { IMBridgeEngine } from './bridge.js';
import {
  createIMBridgeOptionsFromEnv,
  IMBridge,
  type ConversationSnapshot,
} from './bridge.js';
import type { IMChannel, InboundMessage } from './IMChannel.js';
import { createFeishuConfigFromEnv, FeishuChannel } from './feishu.js';

/** Side registry so callers can reach whatever `mountIMChannels` created. */
const mounted = new WeakMap<Hono, MountedIM>();

/** Whatever `mountIMChannels` attached to this app, or undefined. */
export function getMountedIM(app: Hono): MountedIM | undefined {
  return mounted.get(app);
}

export interface MountIMOptions {
  /**
   * Agent engine inbound messages are forwarded to. When omitted the channels
   * still mount (health + webhook plumbing) but nobody consumes the messages.
   */
  engine?: IMBridgeEngine | undefined;
  /** Extra observer for inbound messages, mostly useful in tests. */
  onMessage?: ((message: InboundMessage) => void | Promise<void>) | undefined;
}

export interface MountedIM {
  readonly channels: readonly IMChannel[];
  /** Present whenever an engine was provided. */
  readonly bridge: IMBridge | undefined;
}

/** Starts every configured channel transport. */
export async function startMountedIM(im: MountedIM | undefined): Promise<void> {
  for (const channel of im?.channels ?? []) await channel.start();
}

/** Stops every configured channel transport. */
export async function stopMountedIM(im: MountedIM | undefined): Promise<void> {
  await Promise.all((im?.channels ?? []).map((channel) => channel.stop()));
}

/**
 * Mounts every configured IM channel onto the HTTP app.
 * A channel only mounts when its env credentials are present, so the server
 * starts cleanly with no IM configured at all.
 */
export function mountIMChannels(app: Hono, options: MountIMOptions = {}): MountedIM {
  const channels: IMChannel[] = [];
  const bridge = options.engine
    ? new IMBridge(options.engine, createIMBridgeOptionsFromEnv())
    : undefined;

  if (bridge) {
    app.get('/api/im/conversations', (context) => {
      const conversations: readonly ConversationSnapshot[] =
        bridge?.listConversations() ?? [];
      return context.json({ conversations });
    });
  }

  const feishuConfig = createFeishuConfigFromEnv();
  if (feishuConfig) {
    const feishu = new FeishuChannel(feishuConfig);
    bridge?.attach(feishu);
    if (options.onMessage) feishu.onMessage(options.onMessage);
    app.route('/api/im/feishu', createFeishuRoutes(feishu));
    channels.push(feishu);
  }

  app.get('/api/im/health', (context) => {
    return context.json({
      channels: channels.map((channel) => ({
        id: channel.id,
        ...channel.capabilities,
      })),
    });
  });

  const mountedResult: MountedIM = { channels, bridge };
  mounted.set(app, mountedResult);
  return mountedResult;
}

/** Hono sub-app exposing the Feishu callback endpoints. */
function createFeishuRoutes(channel: FeishuChannel): Hono {
  const routes = new Hono();

  routes.post('/webhook', async (context) => {
    const body = await context.req.text();
    const result = await channel.handleWebhook(body, {
      'x-lark-request-timestamp':
        context.req.header('x-lark-request-timestamp') ?? undefined,
      'x-lark-request-nonce': context.req.header('x-lark-request-nonce') ?? undefined,
      'x-lark-signature': context.req.header('x-lark-signature') ?? undefined,
    });
    return context.json(result.body, result.status as ContentfulStatusCode);
  });

  return routes;
}

export type {
  IMChannel,
  InboundMessage,
  OutboundContent,
  WebhookResult,
} from './IMChannel.js';
export { FeishuChannel, createFeishuConfigFromEnv } from './feishu.js';
export {
  createIMBridgeOptionsFromEnv,
  DEFAULT_IM_BRIDGE_OPTIONS,
  IMBridge,
  type ConversationSnapshot,
  type IMBridgeEngine,
  type IMBridgeOptions,
  type IMRun,
} from './bridge.js';
