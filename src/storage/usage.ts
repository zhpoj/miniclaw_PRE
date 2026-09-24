export interface UsageLedgerEntry {
  runId: string;
  conversationId?: string;
  workspaceId?: string;
  agentProfileId?: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  latencyMs?: number;
  estimatedCost?: number;
  createdAt: string;
}

export interface UsageLedgerRow extends UsageLedgerEntry {
  id: string;
}

export interface UsageLedgerFilter {
  model?: string;
  from?: string;
  to?: string;
}
