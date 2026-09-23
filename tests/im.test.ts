import { createCipheriv } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import {
  computeFeishuSignature,
  createFeishuConfigFromEnv,
  FeishuChannel,
} from '../src/im/feishu.js';

const ENCRYPT_KEY = Buffer.alloc(32, 7).toString('base64');

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeTextMessageEvent(text = 'hello agent', mentions = '@_user_1 ') {
  return {
    schema: '2.0',
    header: {
      event_id: 'evt_1',
      event_type: 'im.message.receive_v1',
      tenant_key: 'tenant_1',
      app_id: 'cli_test',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou_user_1', union_id: 'on_user_1' },
        tenant_key: 'tenant_1',
        type: 'user',
      },
      message: {
        message_id: 'om_msg_1',
        chat_id: 'oc_chat_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: `${mentions}${text}` }),
      },
    },
  };
}

/** Mirrors the server-side envelope: AES-256-CBC with PKCS7 padding, key+IV from the Encrypt Key. */
function encryptFeishuPayload(payload: unknown, encryptKey: string): string {
  const aesKey = Buffer.from(encryptKey, 'base64');
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const padding = 16 - (data.length % 16);
  const padded = Buffer.concat([data, Buffer.alloc(padding, padding)]);
  const cipher = createCipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

function signedHeaders(
  body: string,
  encryptKey: string,
  timestamp: string = String(Math.floor(Date.now() / 1000)),
  nonce: string = 'nonce_1',
): Record<string, string> {
  return {
    'x-lark-request-timestamp': timestamp,
    'x-lark-request-nonce': nonce,
    'x-lark-signature': computeFeishuSignature(encryptKey, timestamp, nonce, body),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createFeishuConfigFromEnv', () => {
  it('returns null when no credentials are configured', () => {
    expect(
      createFeishuConfigFromEnv({ FEISHU_APP_ID: '', FEISHU_APP_SECRET: '' }),
    ).toBeNull();
  });

  it('builds a config from the environment', () => {
    expect(
      createFeishuConfigFromEnv({
        FEISHU_APP_ID: 'cli_1',
        FEISHU_APP_SECRET: 'secret_1',
        FEISHU_ENCRYPT_KEY: ENCRYPT_KEY,
      }),
    ).toEqual({
      appId: 'cli_1',
      appSecret: 'secret_1',
      encryptKey: ENCRYPT_KEY,
      baseUrl: 'https://open.feishu.cn',
      receiveIdType: 'chat_id',
    });
  });
});

describe('FeishuChannel.handleWebhook', () => {
  const channel = new FeishuChannel({ appId: 'cli_1', appSecret: 'secret_1' });

  it('answers the URL verification challenge', async () => {
    const result = await channel.handleWebhook(
      JSON.stringify({ type: 'url_verification', challenge: 'abc123' }),
    );

    expect(result).toEqual({ status: 200, body: { challenge: 'abc123' } });
  });

  it('rejects a payload with a bad signature', async () => {
    const signed = new FeishuChannel({
      appId: 'cli_1',
      appSecret: 'secret_1',
      encryptKey: ENCRYPT_KEY,
    });
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const headers = { ...signedHeaders(body, ENCRYPT_KEY), 'x-lark-signature': 'nope' };

    const result = await signed.handleWebhook(body, headers);

    expect(result.status).toBe(401);
  });

  it('decrypts an encrypted envelope before processing it', async () => {
    const signed = new FeishuChannel({
      appId: 'cli_1',
      appSecret: 'secret_1',
      encryptKey: ENCRYPT_KEY,
    });
    const received: string[] = [];
    const unsubscribe = signed.onMessage((message) => {
      received.push(message.text);
    });
    const body = JSON.stringify({
      encrypt: encryptFeishuPayload(makeTextMessageEvent(), ENCRYPT_KEY),
    });

    const result = await signed.handleWebhook(body, signedHeaders(body, ENCRYPT_KEY));

    expect(result).toEqual({ status: 200, body: { code: 0 } });
    expect(received).toEqual(['hello agent']);
    unsubscribe();
  });

  it('normalizes an inbound text message and strips mention placeholders', async () => {
    const received: Parameters<Parameters<FeishuChannel['onMessage']>[0]>[0][] = [];
    const unsubscribe = channel.onMessage((message) => {
      received.push(message);
    });

    const result = await channel.handleWebhook(JSON.stringify(makeTextMessageEvent()));

    expect(result.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      channelId: 'feishu',
      conversationId: 'oc_chat_1',
      messageId: 'om_msg_1',
      senderId: 'ou_user_1',
      text: 'hello agent',
    });
    unsubscribe();

    const afterUnsubscribe = await channel.handleWebhook(
      JSON.stringify(makeTextMessageEvent()),
    );
    expect(afterUnsubscribe.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  it('ignores non-text messages', async () => {
    const received: unknown[] = [];
    const unsubscribe = channel.onMessage((message) => {
      received.push(message);
    });
    const event = makeTextMessageEvent();
    event.event.message.message_type = 'image';

    const result = await channel.handleWebhook(JSON.stringify(event));

    expect(result.status).toBe(200);
    expect(received).toEqual([]);
    unsubscribe();
  });

  it('reports malformed JSON', async () => {
    const result = await channel.handleWebhook('not-json');
    expect(result.status).toBe(400);
  });
});

describe('FeishuChannel outbound', () => {
  it('caches the tenant token across send and card update', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('tenant_access_token')) {
        return jsonResponse({ code: 0, tenant_access_token: 't_cached', expire: 7200 });
      }
      if (url.includes('/messages?')) {
        return jsonResponse({ code: 0, data: { message_id: 'om_sent' } });
      }
      return jsonResponse({ code: 0 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const channel = new FeishuChannel({
      appId: 'cli_1',
      appSecret: 'secret_1',
      baseUrl: 'https://example.test',
    });

    const sent = await channel.send('oc_chat_1', { text: 'hi there' });
    await channel.update('om_sent', { card: { elements: [] } });

    expect(sent).toEqual({ messageId: 'om_sent' });
    expect(calls).toHaveLength(3);

    expect(calls[0]?.url).toBe(
      'https://example.test/open-apis/auth/v3/tenant_access_token/internal',
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      app_id: 'cli_1',
      app_secret: 'secret_1',
    });

    expect(calls[1]?.url).toBe(
      'https://example.test/open-apis/im/v1/messages?receive_id_type=chat_id',
    );
    expect(calls[1]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      receive_id: 'oc_chat_1',
      msg_type: 'text',
      content: '{"text":"hi there"}',
    });

    expect(calls[2]?.url).toBe('https://example.test/open-apis/im/v1/messages/om_sent');
    expect(calls[2]?.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      msg_type: 'interactive',
      content: '{"elements":[]}',
    });
  });
});

describe('IM mounting', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    for (const key of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']) {
      if (envBackup[key] === undefined) delete process.env[key];
      else process.env[key] = envBackup[key] as string;
    }
  });

  it('mounts nothing when IM channels are unconfigured', async () => {
    const app = createApp();
    const response = await app.request('/api/im/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ channels: [] });
  });

  it('mounts the feishu webhook when its credentials are present', async () => {
    process.env['FEISHU_APP_ID'] = 'cli_1';
    process.env['FEISHU_APP_SECRET'] = 'secret_1';

    const app = createApp();

    const health = await app.request('/api/im/health');
    await expect(health.json()).resolves.toEqual({
      channels: [{ id: 'feishu', streamingCards: true, persistentInbox: false }],
    });

    const response = await app.request('/api/im/feishu/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', challenge: 'abc123' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ challenge: 'abc123' });
  });
});
