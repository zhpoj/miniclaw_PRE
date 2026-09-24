import { describe, expect, it } from 'vitest';

import type {
  AgentEventRecord,
  AgentRunSnapshot,
  PromptOptions,
  PromptResult,
} from '../src/agent/run.js';
import { IMBridge, type IMBridgeEngine, type IMRun } from '../src/im/bridge.js';
import type {
  ChannelCapabilities,
  IMChannel,
  InboundMessage,
  InboundMessageHandler,
  OutboundContent,
} from '../src/im/IMChannel.js';

/** Flushes the background turn microtasks so assertions see settled state. */
async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

class FakeRun {
  readonly id: string;
  readonly prompts: Array<{ text: string; options: PromptOptions }> = [];
  closed = false;
  aborted = false;
  failPrompt = false;
  idleForever = false;

  private seq = 0;
  private readonly listeners = new Set<(event: AgentEventRecord) => void>();
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | undefined;

  constructor(id: string) {
    this.id = id;
  }

  snapshot(): AgentRunSnapshot {
    return {
      id: this.id,
      createdAt: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp/workspace',
      status: 'idle',
      streaming: false,
      tools: ['read', 'write'],
      eventCount: this.seq,
      model: { provider: 'deepseek', id: 'deepseek-v4-pro' },
      thinkingLevel: undefined,
      piSessionId: undefined,
      piSessionFile: undefined,
      lastError: undefined,
    };
  }

  async prompt(text: string, options: PromptOptions = {}): Promise<PromptResult> {
    if (this.failPrompt) throw new Error('model exploded');
    this.prompts.push({ text, options });
    if (this.idleForever) {
      this.idle = new Promise<void>(() => undefined);
    } else {
      this.idle = new Promise<void>((resolve) => {
        this.resolveIdle = resolve;
      });
    }
    return { accepted: true, mode: 'started' };
  }

  awaitIdle(): Promise<void> {
    return this.idle;
  }

  subscribe(listener: (event: AgentEventRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.finish();
  }

  close(): void {
    this.closed = true;
    this.finish();
  }

  /** Test helper: push a live agent event to every subscriber. */
  emit(type: string, payload: unknown): void {
    const record: AgentEventRecord = {
      seq: this.seq++,
      at: new Date().toISOString(),
      type,
      payload,
    };
    for (const listener of this.listeners) listener(record);
  }

  assistantSaid(text: string): void {
    this.emit('message_end', {
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
  }

  finish(): void {
    this.resolveIdle?.();
    this.resolveIdle = undefined;
  }

  get events(): number {
    return this.seq;
  }
}

class FakeEngine {
  readonly created: FakeRun[] = [];

  async createRun(): Promise<IMRun> {
    const run = new FakeRun(`run_${this.created.length + 1}`);
    this.created.push(run);
    return run as unknown as IMRun;
  }

  last(): FakeRun {
    const run = this.created.at(-1);
    if (!run) throw new Error('no run created');
    return run;
  }
}

class FakeChannel implements IMChannel {
  readonly id = 'fake';
  readonly capabilities: ChannelCapabilities = {
    streamingCards: true,
    persistentInbox: false,
  };

  readonly sent: Array<{ conversationId: string; content: OutboundContent }> = [];
  readonly updates: Array<{ messageId: string; content: OutboundContent }> = [];

  private readonly handlers = new Set<InboundMessageHandler>();
  private counter = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(
    conversationId: string,
    content: OutboundContent,
  ): Promise<{ messageId: string }> {
    this.sent.push({ conversationId, content });
    this.counter += 1;
    return { messageId: `msg_${this.counter}` };
  }

  async update(messageId: string, content: OutboundContent): Promise<void> {
    this.updates.push({ messageId, content });
  }

  onMessage(handler: InboundMessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Test helper: deliver a message the way an adapter would. */
  async ingest(text: string, conversationId = 'chat_1'): Promise<void> {
    this.counter += 1;
    const message: InboundMessage = {
      channelId: this.id,
      conversationId,
      messageId: `in_${this.counter}`,
      senderId: 'user_1',
      text,
      raw: {},
    };
    for (const handler of this.handlers) await handler(message);
  }

  texts(): string[] {
    return this.sent
      .map((entry) => entry.content.text)
      .filter((text): text is string => typeof text === 'string');
  }
}

function lastText(channel: FakeChannel): string | undefined {
  return channel.texts().at(-1);
}

function setup(options: Partial<ConstructorParameters<typeof IMBridge>[1]> = {}) {
  const engine = new FakeEngine();
  const channel = new FakeChannel();
  const bridge = new IMBridge(engine as unknown as IMBridgeEngine, options);
  bridge.attach(channel);
  return { engine, channel, bridge };
}

describe('IMBridge', () => {
  it('sends one inbound message to a fresh agent run and answers back', async () => {
    const { engine, channel } = setup();

    await channel.ingest('帮我看看 workspace');
    await settle();

    expect(engine.created).toHaveLength(1);
    const run = engine.last();
    expect(run.prompts).toEqual([
      { text: '帮我看看 workspace', options: { source: 'feishu' } },
    ]);

    run.assistantSaid('workspace 里有一个 demo.html。');
    run.finish();
    await settle();

    expect(lastText(channel)).toBe('workspace 里有一个 demo.html。');
    expect(channel.sent[0]?.conversationId).toBe('chat_1');
  });

  it('relays a desktop-approval requirement back to Feishu', async () => {
    const { engine, channel } = setup();

    await channel.ingest('请修改文件');
    await settle();
    const run = engine.last();
    run.assistantSaid('需要在桌面客户端确认此操作');
    run.finish();
    await settle();

    expect(lastText(channel)).toBe('需要在桌面客户端确认此操作');
    expect(run.prompts[0]).toEqual({
      text: '请修改文件',
      options: { source: 'feishu' },
    });
  });

  it('falls back to streamed deltas when no message_end arrives', async () => {
    const { engine, channel } = setup();

    await channel.ingest('hi');
    await settle();
    const run = engine.last();
    run.emit('message_update', {
      assistantMessageEvent: { type: 'text_delta', delta: '正在读文件…' },
    });
    run.finish();
    await settle();

    expect(lastText(channel)).toBe('正在读文件…');
  });

  it('reuses one run per conversation and isolates different conversations', async () => {
    const { engine, channel } = setup();

    await channel.ingest('第一条');
    await settle();
    engine.last().assistantSaid('ok1');
    engine.last().finish();
    await settle();

    await channel.ingest('第二条');
    await settle();
    engine.last().assistantSaid('ok2');
    engine.last().finish();
    await settle();

    expect(engine.created).toHaveLength(1);
    expect(engine.last().prompts).toEqual([
      { text: '第一条', options: { source: 'feishu' } },
      { text: '第二条', options: { source: 'feishu' } },
    ]);

    await channel.ingest('另一头的消息', 'chat_2');
    await settle();
    expect(engine.created).toHaveLength(2);
    expect(engine.last().id).toBe('run_2');
    expect(engine.last().prompts).toEqual([
      { text: '另一头的消息', options: { source: 'feishu' } },
    ]);
  });

  it('queues messages arriving while a turn is running', async () => {
    const { engine, channel } = setup();

    await channel.ingest('先做这个');
    await settle();
    const first = engine.last();

    await channel.ingest('还有这个');
    await settle();
    expect(first.prompts).toEqual([
      { text: '先做这个', options: { source: 'feishu' } },
    ]);
    expect(channel.texts().some((text) => text.includes('已排队'))).toBe(true);
    expect(engine.created).toHaveLength(1);

    first.assistantSaid('第一个任务好了');
    first.finish();
    await settle();

    expect(first.prompts).toEqual([
      { text: '先做这个', options: { source: 'feishu' } },
      { text: '还有这个', options: { source: 'feishu' } },
    ]);
    expect(channel.texts()).toContain('第一个任务好了');
  });

  it('refuses to queue beyond the configured depth', async () => {
    const { engine, channel } = setup({ maxQueue: 1 });

    await channel.ingest('第一条');
    await settle();
    await channel.ingest('第二条');
    await settle();
    await channel.ingest('第三条');
    await settle();

    expect(channel.texts().some((text) => text.includes('队列也满了'))).toBe(true);
    expect(engine.created).toHaveLength(1);
  });

  it('reopens the session on /new so the next message gets a new run', async () => {
    const { engine, channel } = setup();

    await channel.ingest('第一条');
    await settle();
    engine.last().assistantSaid('ok');
    engine.last().finish();
    await settle();

    await channel.ingest('/new');
    await settle();
    expect(channel.texts().some((text) => text.includes('已重开会话'))).toBe(true);

    await channel.ingest('重新开始');
    await settle();
    expect(engine.created).toHaveLength(2);
    expect(engine.last().prompts).toEqual([
      { text: '重新开始', options: { source: 'feishu' } },
    ]);
  });

  it('answers /status with the current run', async () => {
    const { engine, channel } = setup();

    await channel.ingest('/status');
    await settle();
    expect(channel.texts().some((text) => text.includes('尚未创建'))).toBe(true);

    await channel.ingest('hello');
    await settle();
    engine.last().finish();
    await settle();

    await channel.ingest('/status');
    await settle();
    const status = lastText(channel) ?? '';
    expect(status).toContain('run_1');
    expect(status).toContain('deepseek/deepseek-v4-pro');
  });

  it('aborts the in-flight turn on /abort', async () => {
    const { engine, channel } = setup();

    await channel.ingest('跑个长任务');
    await settle();
    const run = engine.last();

    await channel.ingest('/abort');
    await settle();

    expect(run.aborted).toBe(true);
    expect(channel.texts().some((text) => text.includes('已请求中止'))).toBe(true);
  });

  it('reports failures back into the conversation', async () => {
    const { engine, channel } = setup();

    await channel.ingest('hello');
    await settle();
    engine.last().failPrompt = true;

    await channel.ingest('第二次会因为 prompt 失败');
    await settle();
    engine.last().finish();
    await settle();

    expect(lastText(channel)).toContain('⚠️ 任务失败：model exploded');
  });

  it('gives up on a turn that never settles', async () => {
    const { engine, channel } = setup({ turnTimeoutMs: 20 });

    await channel.ingest('死循环任务');
    await settle();
    engine.last().idleForever = true;
    engine.last().finish();

    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle();

    expect(lastText(channel)).toContain('⚠️ 任务失败');
    expect(lastText(channel)).toContain('超时');
  });

  it('trims answers longer than the configured limit', async () => {
    const { engine, channel } = setup({ maxReplyChars: 5 });

    await channel.ingest('写一篇长文');
    await settle();
    engine.last().assistantSaid('abcdefghij');
    engine.last().finish();
    await settle();

    const reply = lastText(channel) ?? '';
    expect(reply.startsWith('abcde')).toBe(true);
    expect(reply).toContain('原文 10 字');
  });

  it('edits one card in place when streaming is on', async () => {
    const { engine, channel } = setup({ stream: true, streamIntervalMs: 200 });

    await channel.ingest('流式回答');
    await settle();

    // A placeholder is sent before the turn and patched afterwards.
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.content.card).toBeDefined();

    engine.last().assistantSaid('流式结果');
    engine.last().finish();
    await settle();

    expect(channel.updates.length).toBeGreaterThanOrEqual(1);
    const finalCard = channel.updates.at(-1)?.content.card as
      | { elements: Array<{ content: string }> }
      | undefined;
    expect(finalCard?.elements[0]?.content).toContain('流式结果');
  });

  it('drops messages from channels that were never attached', async () => {
    const { bridge } = setup();

    await expect(
      bridge.handle({
        channelId: 'ghost',
        conversationId: 'chat_1',
        messageId: 'm1',
        senderId: 'u1',
        text: 'hello',
        raw: {},
      }),
    ).resolves.toBeUndefined();
  });

  it('closes owned runs on dispose', async () => {
    const { engine, channel, bridge } = setup();

    await channel.ingest('hello');
    await settle();
    const run = engine.last();

    bridge.dispose();
    expect(run.closed).toBe(true);
  });
});
