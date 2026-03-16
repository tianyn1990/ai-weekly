export type OperationJobType =
  | "run_daily"
  | "run_weekly"
  | "recheck_weekly"
  | "watchdog_weekly"
  | "watchdog_weekly_dry_run"
  | "notify_weekly_reminder"
  | "query_weekly_status"
  | "git_sync";

export type OperationJobStatus = "pending" | "running" | "success" | "failed" | "cancelled";

export type OperationProgressPhase = "operation" | "pipeline";

export type OperationPipelineNodeState = "start" | "end";

export interface OperationRuntimeProgress {
  phase: OperationProgressPhase;
  stage: string;
  detail: string;
  updatedAt: string;
  elapsedMs?: number;
  nodeKey?: string;
  nodeState?: OperationPipelineNodeState;
  ok?: boolean;
}

export interface OperationJob {
  id: number;
  jobType: OperationJobType;
  status: OperationJobStatus;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  createdBy?: string;
  source?: string;
  traceId?: string;
  retryCount: number;
  maxRetries: number;
  lastError?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
  runtimeProgress?: OperationRuntimeProgress;
  runtimeProgressEventCount?: number;
}

export interface EnqueueOperationJobInput {
  jobType: OperationJobType;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  createdBy?: string;
  source?: string;
  traceId?: string;
  maxRetries?: number;
}
