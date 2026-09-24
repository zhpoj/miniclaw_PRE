export type MemoryScope = 'global' | 'workspace' | 'conversation';

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  scopeId: string;
  content: string;
  source: string;
  importance: number;
  accessCount: number;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryInput {
  scope: MemoryScope;
  scopeId: string;
  content: string;
  source: string;
  importance?: number;
}
