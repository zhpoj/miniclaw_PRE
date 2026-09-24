export type ReliabilityStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'dead';

export interface ReliabilityQueueInput {
  channelId: string;
  conversationId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  nextAttemptAt: string;
}

export interface ReliabilityQueueItem {
  id: string;
  channelId: string;
  conversationId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: ReliabilityStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | undefined;
  createdAt: string;
  updatedAt: string;
}
