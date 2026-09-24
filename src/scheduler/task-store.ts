export interface ScheduledTask {
  id: string;
  name: string;
  schedule: string;
  conversationId: string;
  payload: Record<string, unknown>;
  enabled: boolean;
  nextRunAt: string;
  createdAt?: string;
  updatedAt?: string;
}

export type TaskRunStatus = 'running' | 'succeeded' | 'failed';

export interface TaskRun {
  id: string;
  taskId: string;
  runId?: string;
  status: TaskRunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface TaskRunResult {
  status: Exclude<TaskRunStatus, 'running'>;
  runId?: string;
  error?: string;
  finishedAt?: string;
}
