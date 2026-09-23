import { createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import * as Lark from '@larksuiteoapi/node-sdk';

import type {
  ChannelCapabilities,
  IMChannel,
  InboundMessage,
  InboundMessageHandler,
  OutboundContent,
  WebhookResult,
} from './IMChannel.js';

export const FEISHU_BASE_URL = 'https://open.feishu.cn';

const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const SIGNATURE_TOLERANCE_MS = 60 * 60 * 1000;

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  /**
   * Encrypt Key from the Feishu console. When present it enables both request
   * signature verification and payload decryption; without it those are skipped.
   */
  encryptKey?: string;
  baseUrl?: string;
  /** How `conversationId` is addressed when sending. Feishu chats use `chat_id`. */
  receiveIdType?: 'chat_id' | 'open_id';
  /** Receive events over the official WebSocket client or the HTTP webhook. */
  connectionMode?: 'websocket' | 'webhook';
}

export interface FeishuEventTransport {
  start(handler: (event: Record<string, unknown>) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

export type FeishuEventTransportFactory = (config: FeishuConfig) => FeishuEventTransport;

/**
 * Builds the Feishu config from the environment, returning null when the
 * channel is not configured so callers can leave it unmounted.
 * - `FEISHU_APP_ID` / `FEISHU_APP_SECRET` (required)
 * - `FEISHU_ENCRYPT_KEY` (optional)
 * - `FEISHU_BASE_URL` (optional, defaults to `https://open.feishu.cn`)
 * - `FEISHU_RECEIVE_ID_TYPE` (optional, `chat_id` | `open_id`)
 * - `FEISHU_CONNECTION_MODE` (optional, `websocket` | `webhook`; defaults to `websocket`)
 */
export function createFeishuConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FeishuConfig | null {
  const appId = env['FEISHU_APP_ID']?.trim();
  const appSecret = env['FEISHU_APP_SECRET']?.trim();
  if (!appId || !appSecret) return null;

  const encryptKey = env['FEISHU_ENCRYPT_KEY']?.trim();
  const baseUrl = env['FEISHU_BASE_URL']?.trim() || FEISHU_BASE_URL;
  const receiveIdType =
    env['FEISHU_RECEIVE_ID_TYPE']?.trim() === 'open_id' ? 'open_id' : 'chat_id';
  const connectionMode =
    env['FEISHU_CONNECTION_MODE']?.trim() === 'webhook' ? 'webhook' : 'websocket';

  return {
    appId,
    appSecret,
    baseUrl,
    receiveIdType,
    connectionMode,
    ...(encryptKey ? { encryptKey } : {}),
  };
}

interface FeishuApiResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
}

interface FeishuTokenResponse extends FeishuApiResponse {
  tenant_access_token?: string;
  expire?: number;
}

/** Feishu adapter skeleton: tenant token, send/update card, signed + encrypted webhook ingestion. */
export class FeishuChannel implements IMChannel {
  readonly id = 'feishu';
  readonly capabilities: ChannelCapabilities = {
    streamingCards: true,
    persistentInbox: false,
  };

  private readonly config: FeishuConfig;
  private readonly handlers = new Set<InboundMessageHandler>();
  private readonly transportFactory: FeishuEventTransportFactory;
  private token: { value: string; expiresAt: number } | null = null;
  private transport: FeishuEventTransport | null = null;

  constructor(
    config: FeishuConfig,
    transportFactory: FeishuEventTransportFactory = createLarkTransport,
  ) {
    this.config = config;
    this.transportFactory = transportFactory;
  }

  async start(): Promise<void> {
    this.token = null;
    if ((this.config.connectionMode ?? 'websocket') === 'webhook' || this.transport) return;

    const transport = this.transportFactory(this.config);
    this.transport = transport;
    try {
      await transport.start(async (event) => {
        const message = this.toInboundMessage(event);
        if (message) await this.dispatch(message);
      });
    } catch (error) {
      this.transport = null;
      await transport.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.token = null;
    const transport = this.transport;
    this.transport = null;
    if (transport) await transport.stop();
  }

  onMessage(handler: InboundMessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Whether this adapter has enough credentials configured to talk to Feishu. */
  isConfigured(): boolean {
    return Boolean(this.config.appId && this.config.appSecret);
  }

  async getTenantAccessToken(): Promise<string> {
    const cached = this.token;
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const response = await fetch(`${this.baseUrl()}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      }),
    });

    const payload = (await response.json()) as FeishuTokenResponse;
    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(
        `feishu token request failed: ${payload.msg ?? `http ${response.status}`}`,
      );
    }

    const ttlMs =
      typeof payload.expire === 'number' ? payload.expire * 1000 : DEFAULT_TOKEN_TTL_MS;
    this.token = {
      value: payload.tenant_access_token,
      expiresAt: Date.now() + Math.max(0, ttlMs - TOKEN_REFRESH_SKEW_MS),
    };
    return this.token.value;
  }

  async send(conversationId: string, content: OutboundContent): Promise<{ messageId: string }> {
    const { msgType, payload } = toFeishuContent(content);
    const data = await this.call<FeishuApiResponse>(
      `/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(this.receiveIdType())}`,
      {
        method: 'POST',
        body: JSON.stringify({
          receive_id: conversationId,
          msg_type: msgType,
          content: payload,
        }),
      },
    );

    const messageId = data.data?.['message_id'];
    if (typeof messageId !== 'string') {
      throw new Error('feishu api error: send response is missing message_id');
    }
    return { messageId };
  }

  /** Streams a new card into an already-sent message. */
  async update(messageId: string, content: OutboundContent): Promise<void> {
    const { msgType, payload } = toFeishuContent(content);
    await this.call(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ msg_type: msgType, content: payload }),
      },
    );
  }

  /**
   * Verifies the `X-Lark-Signature` header against the raw request body.
   * Skipped (returns true) when no Encrypt Key is configured.
   */
  verifySignature(
    body: string,
    headers: Readonly<Record<string, string | undefined>>,
  ): boolean {
    const encryptKey = this.config.encryptKey;
    if (!encryptKey) return true;

    const timestamp = headers['x-lark-request-timestamp'];
    const nonce = headers['x-lark-request-nonce'];
    const signature = headers['x-lark-signature'];
    if (!timestamp || !nonce || !signature) return false;
    if (!isFreshTimestamp(timestamp)) return false;

    const expected = Buffer.from(
      computeFeishuSignature(encryptKey, timestamp, nonce, body),
      'utf8',
    );
    const actual = Buffer.from(signature, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  /**
   * Handles one Feishu webhook delivery: verifies the signature, unwraps the
   * optional encrypted envelope, answers the URL verification challenge and
   * dispatches any message events to the registered handlers.
   */
  async handleWebhook(
    body: string,
    headers: Readonly<Record<string, string | undefined>> = {},
  ): Promise<WebhookResult> {
    if (!this.verifySignature(body, headers)) {
      return {
        status: 401,
        body: {
          error: 'invalid_signature',
          message: 'Feishu signature verification failed.',
        },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { status: 400, body: { error: 'invalid_json', message: 'Body is not valid JSON.' } };
    }
    if (!isRecord(parsed)) {
      return { status: 400, body: { error: 'invalid_payload', message: 'Body is not an object.' } };
    }

    const encrypted = readString(parsed['encrypt']);
    let event = parsed;
    if (encrypted) {
      try {
        const decrypted = this.decrypt(encrypted);
        if (!isRecord(decrypted)) {
          throw new Error('decrypted payload is not an object');
        }
        event = decrypted;
      } catch (error) {
        return {
          status: 400,
          body: { error: 'decrypt_failed', message: errorMessage(error) },
        };
      }
    }

    if (event['type'] === 'url_verification') {
      return { status: 200, body: { challenge: event['challenge'] ?? null } };
    }

    const message = this.toInboundMessage(event);
    if (message) await this.dispatch(message);

    return { status: 200, body: { code: 0 } };
  }

  /** Maps a Feishu event (v1 or v2 shape) onto the generic inbound message. */
  private toInboundMessage(payload: Record<string, unknown>): InboundMessage | null {
    const event = isRecord(payload['event']) ? payload['event'] : payload;
    const message = event['message'];
    if (!isRecord(message)) return null;

    const messageId = readString(message['message_id']);
    const conversationId = readString(message['chat_id']);
    if (!messageId || !conversationId) return null;

    const messageType = readString(message['message_type']);
    if (messageType !== 'text' && messageType !== 'post') return null;

    return {
      channelId: this.id,
      conversationId,
      messageId,
      senderId: readSenderId(event['sender'] ?? message['sender']),
      text: readMessageText(message['content'], messageType),
      raw: message,
    };
  }

  private async dispatch(message: InboundMessage): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(message);
      } catch (error) {
        console.error('[feishu] inbound handler failed:', errorMessage(error));
      }
    }
  }

  /**
   * AES-256-CBC envelope used by Feishu: key is the base64-decoded Encrypt Key,
   * the IV is its first 16 bytes, padding is PKCS7 and thus stripped manually.
   */
  private decrypt(encrypted: string): unknown {
    const encryptKey = this.config.encryptKey;
    if (!encryptKey) {
      throw new Error('FEISHU_ENCRYPT_KEY is not configured');
    }

    const aesKey = Buffer.from(encryptKey, 'base64');
    if (aesKey.length !== 32) {
      throw new Error(`invalid encrypt key length: ${aesKey.length}`);
    }

    const decipher = createDecipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64')),
      decipher.final(),
    ]);
    if (decrypted.length === 0) throw new Error('empty decrypted payload');

    const padding = decrypted[decrypted.length - 1] ?? 0;
    const content = decrypted.subarray(0, decrypted.length - padding);
    return JSON.parse(content.toString('utf8')) as unknown;
  }

  private async call<T extends FeishuApiResponse = FeishuApiResponse>(
    path: string,
    init: { method: string; body?: string },
  ): Promise<T> {
    const token = await this.getTenantAccessToken();
    const response = await fetch(`${this.baseUrl()}${path}`, {
      method: init.method,
      ...(init.body === undefined ? {} : { body: init.body }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
    });

    const payload = (await response.json()) as T;
    if (!response.ok || payload.code !== 0) {
      throw new Error(`feishu api error: ${payload.msg ?? `http ${response.status}`}`);
    }
    return payload;
  }

  private baseUrl(): string {
    return this.config.baseUrl ?? FEISHU_BASE_URL;
  }

  private receiveIdType(): 'chat_id' | 'open_id' {
    return this.config.receiveIdType ?? 'chat_id';
  }
}

function createLarkTransport(config: FeishuConfig): FeishuEventTransport {
  let client: Lark.WSClient | null = null;

  return {
    async start(handler) {
      const dispatcher = new Lark.EventDispatcher({
        ...(config.encryptKey ? { encryptKey: config.encryptKey } : {}),
      }).register({
        'im.message.receive_v1': async (event) => {
          const payload = event as unknown as Record<string, unknown>;
          const nested = isRecord(payload['event']) ? payload['event'] : payload;
          const message = isRecord(nested['message']) ? nested['message'] : undefined;
          console.log('[feishu] received message event', {
            payloadKeys: Object.keys(payload),
            eventKeys: Object.keys(nested),
            messageKeys: message ? Object.keys(message) : [],
            messageType: message?.['message_type'],
          });
          await handler(payload);
        },
      });
      client = new Lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        domain: Lark.Domain.Feishu,
        autoReconnect: true,
        handshakeTimeoutMs: 15_000,
        loggerLevel: Lark.LoggerLevel.info,
        source: 'miniclaw',
      });
      await client.start({ eventDispatcher: dispatcher });
    },
    async stop() {
      client?.close({ force: true });
      client = null;
    },
  };
}

export function computeFeishuSignature(
  encryptKey: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return createHmac('sha256', encryptKey)
    .update(`${timestamp}${nonce}${encryptKey}${body}`)
    .digest('base64');
}

function toFeishuContent(content: OutboundContent): {
  msgType: 'text' | 'interactive';
  payload: string;
} {
  if (content.card) {
    return { msgType: 'interactive', payload: JSON.stringify(content.card) };
  }
  return { msgType: 'text', payload: JSON.stringify({ text: content.text ?? '' }) };
}

function isFreshTimestamp(timestamp: string, toleranceMs = SIGNATURE_TOLERANCE_MS): boolean {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(Date.now() - seconds * 1000) <= toleranceMs;
}

function readSenderId(sender: unknown): string {
  if (!isRecord(sender)) return 'unknown';
  const senderId = sender['sender_id'];
  if (isRecord(senderId)) {
    return (
      readString(senderId['open_id']) ?? readString(senderId['union_id']) ?? 'unknown'
    );
  }
  return readString(senderId) ?? 'unknown';
}

function readMessageText(content: unknown, messageType = 'text'): string {
  if (typeof content !== 'string') return '';
  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed)) {
      if (messageType === 'post') return stripMentions(readPostText(parsed));
      const text = readString(parsed['text']);
      if (text) return stripMentions(text);
    }
  } catch {
    // Not JSON: fall back to the raw string below.
  }
  return stripMentions(content);
}

function readPostText(post: Record<string, unknown>): string {
  const content = Array.isArray(post['content'])
    ? post['content']
    : Object.values(post).find(
        (value): value is Record<string, unknown> =>
          isRecord(value) && Array.isArray(value['content']),
      )?.['content'];
  if (!Array.isArray(content)) return '';

  return content
    .flatMap((paragraph) => (Array.isArray(paragraph) ? paragraph : []))
    .map((element) => (isRecord(element) ? readString(element['text']) ?? '' : ''))
    .join('')
    .trim();
}

/** Feishu replaces mentions with placeholders such as `@_user_1`. */
function stripMentions(text: string): string {
  return text.replace(/@_user_\d+/g, '').trim();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
