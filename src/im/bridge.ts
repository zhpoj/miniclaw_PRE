/**
 * Bridge between IM conversations and agent runs.
 *
 * One agent run per `channelId:conversationId`, so every chat keeps its own
 * coding-agent session and therefore its own context. Turns are serialized per
 * conversation: anything typed while a turn is still running is queued (bounded)
 * instead of being dropped.
 *
 * Inbound handlers must settle fast — IM vendors time a webhook delivery out in
 * about a second — so `handle()` only enqueues and returns; the turn itself runs
 * in the background and answers through the channel afterwards.
 */

import type { AgentEngine } from '../agent/engine.js';
import type { AgentEventRecord, AgentRun } from '../agent/run.js';
import type { IMChannel, InboundMessage, OutboundContent } from './IMChannel.js';

/** Only the engine surface the bridge touches, so tests can inject a fake. */
export type IMBridgeEngine = Pick<AgentEngine, 'createRun'>;
/** Only the run surface the bridge touches. `AgentRun` satisfies it structurally. */
export type IMRun = Pick<
  AgentRun,
  'id' | 'snapshot' | 'prompt' | 'awaitIdle' | 'subscribe' | 'abort' | 'close'
>;

export interface IMBridgeOptions {
  /** Give up on a turn that has not settled in time (ms). 0 disables the guard. */
  turnTimeoutMs: number;
  /** How many messages may wait behind an in-flight turn. */
  maxQueue: number;
  /** Conversations kept warm at once; beyond this the least recently used one is closed. */
  maxConversations: number;
  /** Edit one reply in place while the answer streams in, instead of one final message. */
  stream: boolean;
  /** Minimum interval between two in-place edits while streaming. */
  streamIntervalMs: number;
  /** Upper bound for one reply; longer answers are trimmed with a notice. */
  maxReplyChars: number;
}

export const DEFAULT_IM_BRIDGE_OPTIONS: IMBridgeOptions = {
  turnTimeoutMs: 10 * 60 * 1000,
  maxQueue: 3,
  maxConversations: 50,
  stream: false,
  streamIntervalMs: 1500,
  maxReplyChars: 4000,
};

const HELP_TEXT = [
  'MiniAgent 已连接。',
  '',
  '直接发文本 = 派一个任务给 agent（同一会话共享上下文）。',
  '',
  '命令：',
  '/new（或 /reset） 重开会话，清空上下文',
  '/status 查看当前会话（run id / 模型 / 工具）',
  '/abort 中止正在跑的任务',
  '/help 显示本帮助',
].join('\n');

const PLACEHOLDER_TEXT = '⏳ 正在处理…';
const EMPTY_TURN_TEXT = '（本轮没有产生文本回复）';

/** Builds bridge options from the environment. */
export function createIMBridgeOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): IMBridgeOptions {
  const base = DEFAULT_IM_BRIDGE_OPTIONS;
  return {
    turnTimeoutMs: readPositiveInt(env['IM_TURN_TIMEOUT_MS'], base.turnTimeoutMs, 0),
    maxQueue: readPositiveInt(env['IM_MAX_QUEUE'], base.maxQueue, 0),
    maxConversations: readPositiveInt(env['IM_MAX_CONVERSATIONS'], base.maxConversations, 1),
    stream: env['IM_STREAMING'] === '1',
    streamIntervalMs: readPositiveInt(env['IM_STREAM_INTERVAL_MS'], base.streamIntervalMs, 200),
    maxReplyChars: readPositiveInt(env['IM_MAX_REPLY_CHARS'], base.maxReplyChars, 200),
  };
}

interface ConversationBinding {
  readonly key: string;
  readonly channelId: string;
  readonly conversationId: string;
  run: IMRun | undefined;
  creating: Promise<IMRun> | undefined;
  running: boolean;
  queue: InboundMessage[];
  updatedAt: number;
}

export interface ConversationSnapshot {
  readonly key: string;
  readonly channelId: string;
  readonly conversationId: string;
  readonly runId: string | undefined;
  readonly running: boolean;
  readonly queued: number;
  readonly updatedAt: string;
}

/**
 * Owns the `conversation -> agent run` bindings and drives one turn at a time.
 */
export class IMBridge {
  private readonly engine: IMBridgeEngine;
  private readonly options: IMBridgeOptions;
  private readonly channels = new Map<string, IMChannel>();
  private readonly subscriptions = new Map<string, () => void>();
  private readonly bindings = new Map<string, ConversationBinding>();

  constructor(engine: IMBridgeEngine, options: Partial<IMBridgeOptions> = {}) {
    this.engine = engine;
    this.options = { ...DEFAULT_IM_BRIDGE_OPTIONS, ...options };
  }

  /**
   * Register a channel and start consuming its inbound messages. Also detaches
   * it again when the returned function is called.
   */
  attach(channel: IMChannel): () => void {
    const unsubscribe = channel.onMessage((message) => {
      void this.handle(message).catch((error: unknown) => {
        console.error(`[im] failed to accept a ${channel.id} message:`, describeError(error));
      });
    });
    this.channels.set(channel.id, channel);
    this.subscriptions.set(channel.id, unsubscribe);
    return () => {
      this.detach(channel.id);
    };
  }

  detach(channelId: string): void {
    this.subscriptions.get(channelId)?.();
    this.subscriptions.delete(channelId);
    this.channels.delete(channelId);
  }

  /**
   * Accept one inbound message. Resolves as soon as the message is taken over;
   * the agent turn keeps running in the background.
   */
  async handle(message: InboundMessage): Promise<void> {
    const channel = this.channels.get(message.channelId);
    if (!channel) {
      console.warn(
        `[im] dropped a message from unknown channel "${message.channelId}" (not attached)`,
      );
      return;
    }

    const binding = this.ensureBinding(message);
    binding.updatedAt = Date.now();

    const text = message.text.trim();
    if (text.startsWith('/')) {
      await this.runCommand(channel, binding, text);
      return;
    }
    if (text.length === 0) return;

    if (binding.running) {
      if (binding.queue.length >= this.options.maxQueue) {
        await this.trySend(
          channel,
          binding.conversationId,
          { text: '⏳ 当前任务还没跑完，队列也满了，稍等一会儿再发。' },
        );
        return;
      }
      binding.queue.push(message);
      await this.trySend(
        channel,
        binding.conversationId,
        { text: `📥 已排队，前面还有 ${binding.queue.length - 1} 条。` },
      );
      return;
    }

    this.startTurn(channel, binding, message);
  }

  /** Read-only view of every live binding, useful for /status and health checks. */
  listConversations(): ConversationSnapshot[] {
    return [...this.bindings.values()].map((binding) => ({
      key: binding.key,
      channelId: binding.channelId,
      conversationId: binding.conversationId,
      runId: binding.run?.id,
      running: binding.running,
      queued: binding.queue.length,
      updatedAt: new Date(binding.updatedAt).toISOString(),
    }));
  }

  /** Release every run owned by the bridge and stop consuming its channels. */
  dispose(): void {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.channels.clear();
    for (const binding of this.bindings.values()) {
      binding.queue = [];
      binding.creating = undefined;
      try {
        binding.run?.close();
      } catch (error) {
        console.warn(`[im] failed to close run ${binding.run?.id}:`, describeError(error));
      }
      binding.run = undefined;
    }
    this.bindings.clear();
  }

  private startTurn(
    channel: IMChannel,
    binding: ConversationBinding,
    message: InboundMessage,
  ): void {
    void this.runTurn(channel, binding, message).catch((error: unknown) => {
      console.error(`[im] turn failed for ${binding.key}:`, describeError(error));
    });
  }

  private async runTurn(
    channel: IMChannel,
    binding: ConversationBinding,
    message: InboundMessage,
  ): Promise<void> {
    binding.running = true;
    binding.updatedAt = Date.now();
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let replyId: string | undefined;

    try {
      const run = await this.resolveRun(binding);
      const collector = collectAssistantText(run);
      unsubscribe = collector.stop;

      if (this.options.stream) {
        const sent = await this.trySend(channel, binding.conversationId, {
          card: buildCard(PLACEHOLDER_TEXT),
        });
        replyId = sent?.messageId;
        if (replyId) {
          let flushed = '';
          const target = replyId;
          timer = setInterval(() => {
            const text = collector.text();
            if (!text || text === flushed) return;
            flushed = text;
            void channel
              .update(target, { card: buildCard(formatReply(text, this.options)) })
              .catch((error: unknown) => {
                console.error('[im] streaming update failed:', describeError(error));
              });
          }, this.options.streamIntervalMs);
        }
      }

      await run.prompt(message.text);
      await this.waitForIdle(run);

      await this.deliver(channel, binding, collector.text(), replyId);
    } catch (error) {
      await this.deliver(
        channel,
        binding,
        `⚠️ 任务失败：${describeError(error)}`,
        replyId,
      );
    } finally {
      if (timer) clearInterval(timer);
      unsubscribe?.();
      binding.running = false;
      this.drain(channel, binding);
    }
  }

  private drain(channel: IMChannel, binding: ConversationBinding): void {
    const next = binding.queue.shift();
    if (!next) return;
    this.startTurn(channel, binding, next);
  }

  private async deliver(
    channel: IMChannel,
    binding: ConversationBinding,
    text: string,
    replyId: string | undefined,
  ): Promise<void> {
    const body = formatReply(text, this.options);
    if (replyId) {
      try {
        await channel.update(replyId, { card: buildCard(body) });
        return;
      } catch (error) {
        console.error('[im] failed to update reply card:', describeError(error));
      }
    }
    await this.trySend(channel, binding.conversationId, { text: body });
  }

  private async runCommand(
    channel: IMChannel,
    binding: ConversationBinding,
    raw: string,
  ): Promise<void> {
    const [head, ...rest] = raw.slice(1).split(/\s+/);
    const name = (head ?? '').toLowerCase();

    switch (name) {
      case 'help':
        await this.trySend(channel, binding.conversationId, { text: HELP_TEXT });
        return;
      case 'new':
      case 'reset': {
        this.closeRun(binding);
        const note = rest.join(' ').trim();
        await this.trySend(channel, binding.conversationId, {
          text: note
            ? `🧹 已重开会话。你刚才说的「${note}」由于上下文清空没有执行，请再发一次。`
            : '🧹 已重开会话，上下文已清空。',
        });
        return;
      }
      case 'abort': {
        const run = binding.run;
        if (!run) {
          await this.trySend(channel, binding.conversationId, { text: '当前没有进行中的会话。' });
          return;
        }
        try {
          await run.abort();
          await this.trySend(channel, binding.conversationId, { text: '🛑 已请求中止。' });
        } catch (error) {
          await this.trySend(channel, binding.conversationId, {
            text: `⚠️ 中止失败：${describeError(error)}`,
          });
        }
        return;
      }
      case 'status': {
        await this.trySend(channel, binding.conversationId, {
          text: this.describeBinding(binding),
        });
        return;
      }
      default:
        await this.trySend(channel, binding.conversationId, {
          text: `未知命令 /${name}。\n\n${HELP_TEXT}`,
        });
    }
  }

  private describeBinding(binding: ConversationBinding): string {
    const run = binding.run;
    if (!run) {
      return [
        '会话尚未创建（下一条消息会新建一个 run）。',
        `对话：${binding.channelId}:${binding.conversationId}`,
      ].join('\n');
    }
    const snap = run.snapshot();
    const model = snap.model ? `${snap.model.provider}/${snap.model.id}` : 'unknown';
    return [
      `run：${snap.id}`,
      `状态：${snap.status}${binding.running ? '（正在执行）' : ''}`,
      `模型：${model}`,
      `工具：${snap.tools.join(', ') || 'none'}`,
      `工作区：${snap.cwd}`,
      `事件数：${snap.eventCount}`,
      `队列：${binding.queue.length} 条等待`,
      ...(snap.lastError ? [`上次错误：${snap.lastError}`] : []),
    ].join('\n');
  }

  private async resolveRun(binding: ConversationBinding): Promise<IMRun> {
    if (binding.run) return binding.run;
    binding.creating ??= this.engine
      .createRun({})
      .then((run: IMRun) => {
        binding.run = run;
        binding.creating = undefined;
        return run;
      })
      .catch((error: unknown) => {
        binding.creating = undefined;
        throw error;
      });
    return binding.creating;
  }

  private closeRun(binding: ConversationBinding): void {
    const run = binding.run;
    binding.run = undefined;
    binding.creating = undefined;
    binding.queue = [];
    if (!run) return;
    try {
      run.close();
    } catch (error) {
      console.warn(`[im] failed to close run ${run.id}:`, describeError(error));
    }
  }

  private async waitForIdle(run: IMRun): Promise<void> {
    const timeoutMs = this.options.turnTimeoutMs;
    if (timeoutMs <= 0) {
      await run.awaitIdle();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        run.awaitIdle(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`任务超时：${Math.round(timeoutMs / 1000)}s 内没有跑完`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async trySend(
    channel: IMChannel,
    conversationId: string,
    content: OutboundContent,
  ): Promise<{ messageId: string } | undefined> {
    try {
      return await channel.send(conversationId, content);
    } catch (error) {
      console.error(
        `[im] failed to send into ${channel.id}:${conversationId}:`,
        describeError(error),
      );
      return undefined;
    }
  }

  private ensureBinding(message: InboundMessage): ConversationBinding {
    const key = `${message.channelId}:${message.conversationId}`;
    const existing = this.bindings.get(key);
    if (existing) return existing;

    this.evictIfOverflowing();
    const binding: ConversationBinding = {
      key,
      channelId: message.channelId,
      conversationId: message.conversationId,
      run: undefined,
      creating: undefined,
      running: false,
      queue: [],
      updatedAt: Date.now(),
    };
    this.bindings.set(key, binding);
    return binding;
  }

  /** Keeps memory bounded by dropping the least recently used conversation. */
  private evictIfOverflowing(): void {
    const limit = this.options.maxConversations;
    if (this.bindings.size < limit) return;

    let oldest: ConversationBinding | undefined;
    for (const binding of this.bindings.values()) {
      if (binding.running || binding.queue.length > 0) continue;
      if (!oldest || binding.updatedAt < oldest.updatedAt) oldest = binding;
    }
    if (!oldest) return;
    this.bindings.delete(oldest.key);
    try {
      oldest.run?.close();
    } catch (error) {
      console.warn(`[im] failed to close evicted run:`, describeError(error));
    }
  }
}

interface TextCollector {
  /** Assistant text produced since the collector was installed. */
  text(): string;
  stop(): void;
}

/**
 * Subscribes to a run and pieced together the assistant answer: every completed
 * assistant message contributes its full text, and while nothing has completed
 * yet the raw streamed deltas are used so a timeout still returns something.
 */
export function collectAssistantText(run: IMRun): TextCollector {
  const segments: string[] = [];
  let streaming = '';

  const unsubscribe = run.subscribe((event: AgentEventRecord) => {
    if (event.type === 'message_end') {
      const text = assistantText(event.payload);
      if (text) segments.push(text);
      streaming = '';
      return;
    }
    if (event.type === 'message_update') {
      const delta = textDelta(event.payload);
      if (delta) streaming += delta;
    }
  });

  return {
    text: () => {
      const done = segments.filter((segment) => segment.trim().length > 0).join('\n\n').trim();
      return done || streaming.trim();
    },
    stop: unsubscribe,
  };
}

function assistantText(payload: unknown): string {
  const message = readField(payload, 'message');
  if (!isRecord(message)) return '';
  if (message['role'] !== 'assistant') return '';
  return contentText(message['content']);
}

function textDelta(payload: unknown): string {
  const event = readField(payload, 'assistantMessageEvent');
  if (!isRecord(event)) return '';
  if (event['type'] !== 'text_delta') return '';
  const delta = event['delta'];
  return typeof delta === 'string' ? delta : '';
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) ? contentText(block['text']) : ''))
      .filter((text) => text.length > 0)
      .join('\n');
  }
  if (isRecord(content)) return contentText(content['text']);
  return '';
}

/** Trims an oversized answer instead of letting the vendor reject it. */
export function formatReply(text: string, options: IMBridgeOptions): string {
  const body = text.trim() || EMPTY_TURN_TEXT;
  const limit = options.maxReplyChars;
  if (body.length <= limit) return body;
  return `${body.slice(0, limit)}\n…（回复过长已截断，原文 ${body.length} 字）`;
}

/** A minimal Feishu interactive card so long answers render nicely in chat. */
export function buildCard(text: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'MiniAgent' },
      template: 'blue',
    },
    elements: [{ tag: 'markdown', content: text }],
  };
}

function readField(payload: unknown, key: string): unknown {
  return isRecord(payload) ? payload[key] : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPositiveInt(raw: string | undefined, fallback: number, min: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const value = Math.floor(parsed);
  return value >= min ? value : fallback;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
