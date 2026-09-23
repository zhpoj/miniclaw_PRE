/**
 * Thin, transport-agnostic contract shared by every IM adapter.
 *
 * Each adapter translates between its vendor payloads and these shapes, so the
 * agent side only ever deals with `InboundMessage` / `OutboundContent`.
 */

export interface ChannelCapabilities {
  /** Whether a sent message can be edited afterwards, e.g. a streaming answer card. */
  readonly streamingCards: boolean;
  /** Whether the channel keeps a queryable history we could read back. */
  readonly persistentInbox: boolean;
}

/** A normalized message coming in from an IM channel. */
export interface InboundMessage {
  /** Id of the adapter instance that produced this message, e.g. `feishu`. */
  readonly channelId: string;
  /** Conversation (chat/session) this message belongs to; replies go back here. */
  readonly conversationId: string;
  /** Channel-side id of this message, useful for threading and reaction updates. */
  readonly messageId: string;
  /** Stable sender identifier within the channel. */
  readonly senderId: string;
  /** Plain text body after vendor formatting has been stripped. */
  readonly text: string;
  /** Vendor payload kept for handlers that need adapter-specific fields. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** What we send out. `card` wins over `text` when both are provided. */
export interface OutboundContent {
  readonly text?: string;
  readonly card?: Readonly<Record<string, unknown>>;
}

export type InboundMessageHandler = (message: InboundMessage) => void | Promise<void>;

export interface IMChannel {
  readonly id: string;
  readonly capabilities: ChannelCapabilities;

  /** Bring the transport up (polling loop, gateway handshake, ...). No-op for pure webhook adapters. */
  start(): Promise<void>;
  stop(): Promise<void>;

  /** Post a new message into a conversation, returning its channel-side id. */
  send(conversationId: string, content: OutboundContent): Promise<{ messageId: string }>;
  /** Patch an existing message in place, used to stream an answer into a card. */
  update(messageId: string, content: OutboundContent): Promise<void>;

  /** Subscribe to inbound messages; the returned function unsubscribes. */
  onMessage(handler: InboundMessageHandler): () => void;
}

/** Result an adapter produces for an inbound webhook call, rendered by the HTTP layer. */
export interface WebhookResult {
  readonly status: number;
  readonly body: unknown;
}
