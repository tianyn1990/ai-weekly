import { z } from "zod";

import { SqliteEngine } from "../storage/sqlite-engine.js";
import type {
  EnqueueOperationJobInput,
  OperationJob,
  OperationJobStatus,
  OperationJobType,
  OperationRuntimeProgress,
} from "./types.js";

const OPERATION_DEDUPE_COOLDOWN_SECONDS = 120;
const RUNTIME_PROGRESS_KEY = "__runtimeProgress";
const RUNTIME_PROGRESS_EVENT_COUNT_KEY = "__runtimeProgressEventCount";

const operationRuntimeProgressSchema = z.object({
  phase: z.enum(["operation", "pipeline"]),
  stage: z.string().min(1),
  detail: z.string(),
  updatedAt: z.string().datetime(),
  elapsedMs: z.number().nonnegative().optional(),
  nodeKey: z.string().optional(),
  nodeState: z.enum(["start", "end"]).optional(),
  ok: z.boolean().optional(),
});

const operationJobRowSchema = z.object({
  id: z.number(),
  job_type: z.string(),
  status: z.string(),
  payload_json: z.string(),
  dedupe_key: z.string().nullable().optional(),
  created_by: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  trace_id: z.string().nullable().optional(),
  retry_count: z.number(),
  max_retries: z.number(),
  last_error: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export class DbOperationJobStore {
  constructor(private readonly engine: SqliteEngine) {}

  async enqueue(input: EnqueueOperationJobInput): Promise<{ jobId: number; created: boolean }> {
    const now = new Date().toISOString();
    const dedupeCreatedAfter = new Date(Date.now() - OPERATION_DEDUPE_COOLDOWN_SECONDS * 1000).toISOString();
    return this.engine.write((ctx) => {
      if (input.dedupeKey) {
        const duplicated = ctx.queryOne<{ id: number }>(
          `
          SELECT id
          FROM operation_jobs
          WHERE dedupe_key = $dedupeKey
            AND created_at >= $dedupeCreatedAfter
          ORDER BY id DESC
          LIMIT 1;
          `,
          {
            $dedupeKey: input.dedupeKey,
            $dedupeCreatedAfter: dedupeCreatedAfter,
          },
        );
        if (duplicated?.id) {
          // 点击双回调在“首个任务已执行完成”后仍可能到达，这里按短窗口去重，避免同一动作被重复执行。
          return { jobId: duplicated.id, created: false };
        }
      }

      ctx.run(
        `
        INSERT INTO operation_jobs (
          job_type, status, payload_json, dedupe_key, created_by, source, trace_id,
          retry_count, max_retries, created_at, updated_at
        ) VALUES (
          $jobType, 'pending', $payloadJson, $dedupeKey, $createdBy, $source, $traceId,
          0, $maxRetries, $createdAt, $updatedAt
        );
        `,
        {
          $jobType: input.jobType,
          $payloadJson: JSON.stringify(input.payload),
          $dedupeKey: input.dedupeKey ?? null,
          $createdBy: input.createdBy ?? null,
          $source: input.source ?? null,
          $traceId: input.traceId ?? null,
          $maxRetries: Math.max(0, input.maxRetries ?? 0),
          $createdAt: now,
          $updatedAt: now,
        },
      );

      const row = ctx.queryOne<{ id: number }>("SELECT CAST(last_insert_rowid() AS INTEGER) AS id;");
      return { jobId: row?.id ?? 0, created: true };
    });
  }

  async pickNextPending(): Promise<OperationJob | null> {
    const now = new Date().toISOString();
    return this.engine.write((ctx) => {
      const next = ctx.queryOne<{ id: number }>(
        `
        SELECT id
        FROM operation_jobs
        WHERE status = 'pending'
        ORDER BY created_at ASC, id ASC
        LIMIT 1;
        `,
      );

      if (!next?.id) {
        return null;
      }

      ctx.run(
        `
        UPDATE operation_jobs
        SET status = 'running', started_at = $now, updated_at = $now
        WHERE id = $id AND status = 'pending';
        `,
        { $id: next.id, $now: now },
      );

      const picked = ctx.queryOne<Record<string, unknown>>(
        `
        SELECT id, job_type, status, payload_json, dedupe_key, created_by, source, trace_id,
               retry_count, max_retries, last_error, started_at, finished_at, created_at, updated_at
        FROM operation_jobs
        WHERE id = $id
        LIMIT 1;
        `,
        { $id: next.id },
      );

      if (!picked) {
        return null;
      }

      return toOperationJob(operationJobRowSchema.parse(picked));
    });
  }

  async markSuccess(jobId: number): Promise<void> {
    const now = new Date().toISOString();
    await this.engine.write((ctx) => {
      ctx.run(
        `
        UPDATE operation_jobs
        SET status = 'success', finished_at = $now, updated_at = $now, last_error = NULL
        WHERE id = $id AND status IN ('running', 'pending');
        `,
        { $id: jobId, $now: now },
      );
    });
  }

  async markFailed(jobId: number, errorMessage: string): Promise<{ requeued: boolean; retryCount: number }> {
    const now = new Date().toISOString();
    return this.engine.write((ctx) => {
      const row = ctx.queryOne<{ retry_count: number; max_retries: number; status: string }>(
        "SELECT retry_count, max_retries, status FROM operation_jobs WHERE id = $id LIMIT 1;",
        { $id: jobId },
      );
      if (!row) {
        return { requeued: false, retryCount: 0 };
      }
      if (row.status === "cancelled") {
        // 已进入取消终态后，失败回写不应覆盖取消结果。
        return { requeued: false, retryCount: row.retry_count };
      }
      if (row.status !== "running") {
        return { requeued: false, retryCount: row.retry_count };
      }

      const nextRetry = row.retry_count + 1;
      const shouldRequeue = nextRetry <= row.max_retries;
      const nextStatus: OperationJobStatus = shouldRequeue ? "pending" : "failed";

      ctx.run(
        `
        UPDATE operation_jobs
        SET status = $status,
            retry_count = $retryCount,
            last_error = $lastError,
            finished_at = CASE WHEN $status = 'failed' THEN $now ELSE finished_at END,
            updated_at = $now
        WHERE id = $id;
        `,
        {
          $id: jobId,
          $status: nextStatus,
          $retryCount: nextRetry,
          $lastError: errorMessage,
          $now: now,
        },
      );

      return { requeued: shouldRequeue, retryCount: nextRetry };
    });
  }

  async markCancelled(jobId: number, reason: string): Promise<boolean> {
    const now = new Date().toISOString();
    return this.engine.write((ctx) => {
      const row = ctx.queryOne<{ status: string }>("SELECT status FROM operation_jobs WHERE id = $id LIMIT 1;", { $id: jobId });
      if (!row) {
        return false;
      }
      if (row.status === "cancelled" || row.status === "success" || row.status === "failed") {
        return false;
      }

      ctx.run(
        `
        UPDATE operation_jobs
        SET status = 'cancelled', dedupe_key = NULL, last_error = $reason, finished_at = $now, updated_at = $now
        WHERE id = $id;
        `,
        { $id: jobId, $reason: reason, $now: now },
      );
      return true;
    });
  }

  async updateRuntimeProgress(jobId: number, progress: OperationRuntimeProgress): Promise<boolean> {
    const now = new Date().toISOString();
    return this.engine.write((ctx) => {
      const row = ctx.queryOne<{ status: string; payload_json: string }>(
        "SELECT status, payload_json FROM operation_jobs WHERE id = $id LIMIT 1;",
        { $id: jobId },
      );
      if (!row) {
        return false;
      }
      if (row.status !== "running" && row.status !== "pending") {
        return false;
      }

      const payload = parsePayloadJson(row.payload_json);
      const currentCount =
        typeof payload[RUNTIME_PROGRESS_EVENT_COUNT_KEY] === "number" &&
        Number.isFinite(payload[RUNTIME_PROGRESS_EVENT_COUNT_KEY])
          ? Number(payload[RUNTIME_PROGRESS_EVENT_COUNT_KEY])
          : 0;
      // 运行态进度落在 payload_json 内，避免引入额外 migration 成本且保持旧数据兼容。
      payload[RUNTIME_PROGRESS_KEY] = progress;
      payload[RUNTIME_PROGRESS_EVENT_COUNT_KEY] = currentCount + 1;

      ctx.run(
        `
        UPDATE operation_jobs
        SET payload_json = $payloadJson, updated_at = $now
        WHERE id = $id;
        `,
        {
          $id: jobId,
          $payloadJson: JSON.stringify(payload),
          $now: now,
        },
      );
      return true;
    });
  }

  async requestCancelCurrent(input: { operator?: string; reason?: string }): Promise<{
    found: boolean;
    jobId?: number;
    jobType?: OperationJobType;
    status?: OperationJobStatus;
    alreadyRequested?: boolean;
    reportDate?: string;
  }> {
    const now = new Date().toISOString();
    const reason = formatCancelReason(input);
    return this.engine.write((ctx) => {
      // 先取 running，再回退 pending，保证“中止本次运行”优先作用于正在执行的任务。
      const target = ctx.queryOne<{ id: number; job_type: string; status: string; last_error: string | null; payload_json: string }>(
        `
        SELECT id, job_type, status, last_error, payload_json
        FROM operation_jobs
        WHERE status IN ('running', 'pending')
        ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END ASC, created_at ASC, id ASC
        LIMIT 1;
        `,
      );
      if (!target?.id) {
        return { found: false };
      }

      const targetPayload = parsePayloadJson(target.payload_json);
      const reportDate = getPayloadReportDate(targetPayload);

      if (target.status === "pending") {
        ctx.run(
          `
          UPDATE operation_jobs
          SET status = 'cancelled', dedupe_key = NULL, last_error = $reason, finished_at = $now, updated_at = $now
          WHERE id = $id AND status = 'pending';
          `,
          { $id: target.id, $reason: reason, $now: now },
        );
        return {
          found: true,
          jobId: target.id,
          jobType: target.job_type as OperationJobType,
          status: "cancelled",
          reportDate,
        };
      }

      const alreadyRequested = isCancelRequestedMessage(target.last_error ?? undefined);
      if (!alreadyRequested) {
        ctx.run(
          `
          UPDATE operation_jobs
          SET dedupe_key = NULL, last_error = $reason, updated_at = $now
          WHERE id = $id AND status = 'running';
          `,
          { $id: target.id, $reason: reason, $now: now },
        );
      } else {
        // 二次点击中止可视为“强制结束”意图：直接落终态，避免僵尸 running 长时间占用 dedupe 队列入口。
        ctx.run(
          `
          UPDATE operation_jobs
          SET status = 'cancelled', dedupe_key = NULL, finished_at = $now, updated_at = $now
          WHERE id = $id AND status = 'running';
          `,
          { $id: target.id, $now: now },
        );
        return {
          found: true,
          jobId: target.id,
          jobType: target.job_type as OperationJobType,
          status: "cancelled",
          alreadyRequested: true,
          reportDate,
        };
      }
      return {
        found: true,
        jobId: target.id,
        jobType: target.job_type as OperationJobType,
        status: "running",
        alreadyRequested,
        reportDate,
      };
    });
  }

  async requestCancelByJobId(input: {
    jobId: number;
    operator?: string;
    reason?: string;
  }): Promise<{
    found: boolean;
    jobId?: number;
    jobType?: OperationJobType;
    status?: OperationJobStatus;
    alreadyRequested?: boolean;
    reportDate?: string;
  }> {
    const now = new Date().toISOString();
    const reason = formatCancelReason(input);
    return this.engine.write((ctx) => {
      const target = ctx.queryOne<{ id: number; job_type: string; status: string; last_error: string | null; payload_json: string }>(
        `
        SELECT id, job_type, status, last_error, payload_json
        FROM operation_jobs
        WHERE id = $id
        LIMIT 1;
        `,
        { $id: input.jobId },
      );
      if (!target) {
        return { found: false };
      }
      const targetPayload = parsePayloadJson(target.payload_json);
      const reportDate = getPayloadReportDate(targetPayload);

      if (target.status === "pending") {
        ctx.run(
          `
          UPDATE operation_jobs
          SET status = 'cancelled', dedupe_key = NULL, last_error = $reason, finished_at = $now, updated_at = $now
          WHERE id = $id AND status = 'pending';
          `,
          { $id: target.id, $reason: reason, $now: now },
        );
        return {
          found: true,
          jobId: target.id,
          jobType: target.job_type as OperationJobType,
          status: "cancelled",
          reportDate,
        };
      }

      if (target.status === "running") {
        const alreadyRequested = isCancelRequestedMessage(target.last_error ?? undefined);
        if (!alreadyRequested) {
          ctx.run(
            `
            UPDATE operation_jobs
            SET dedupe_key = NULL, last_error = $reason, updated_at = $now
            WHERE id = $id AND status = 'running';
            `,
            { $id: target.id, $reason: reason, $now: now },
          );
          return {
            found: true,
            jobId: target.id,
            jobType: target.job_type as OperationJobType,
            status: "running",
            alreadyRequested,
            reportDate,
          };
        }
        ctx.run(
          `
          UPDATE operation_jobs
          SET status = 'cancelled', dedupe_key = NULL, finished_at = $now, updated_at = $now
          WHERE id = $id AND status = 'running';
          `,
          { $id: target.id, $now: now },
        );
        return {
          found: true,
          jobId: target.id,
          jobType: target.job_type as OperationJobType,
          status: "cancelled",
          alreadyRequested: true,
          reportDate,
        };
      }

      return {
        found: true,
        jobId: target.id,
        jobType: target.job_type as OperationJobType,
        status: target.status as OperationJobStatus,
        alreadyRequested: true,
        reportDate,
      };
    });
  }

  async isCancelRequested(jobId: number): Promise<boolean> {
    return this.engine.read((ctx) => {
      const row = ctx.queryOne<{ status: string; last_error: string | null }>(
        "SELECT status, last_error FROM operation_jobs WHERE id = $id LIMIT 1;",
        { $id: jobId },
      );
      if (!row) {
        return false;
      }
      if (row.status === "cancelled") {
        return true;
      }
      return isCancelRequestedMessage(row.last_error ?? undefined);
    });
  }

  async getById(jobId: number): Promise<OperationJob | null> {
    return this.engine.read((ctx) => {
      const row = ctx.queryOne<Record<string, unknown>>(
        `
        SELECT id, job_type, status, payload_json, dedupe_key, created_by, source, trace_id,
               retry_count, max_retries, last_error, started_at, finished_at, created_at, updated_at
        FROM operation_jobs
        WHERE id = $id
        LIMIT 1;
        `,
        { $id: jobId },
      );
      if (!row) {
        return null;
      }
      return toOperationJob(operationJobRowSchema.parse(row));
    });
  }

  async listRecent(limit = 20): Promise<OperationJob[]> {
    return this.engine.read((ctx) => {
      const rows = ctx.queryMany<Record<string, unknown>>(
        `
        SELECT id, job_type, status, payload_json, dedupe_key, created_by, source, trace_id,
               retry_count, max_retries, last_error, started_at, finished_at, created_at, updated_at
        FROM operation_jobs
        ORDER BY id DESC
        LIMIT $limit;
        `,
        { $limit: Math.max(1, Math.min(500, limit)) },
      );
      return rows.map((row) => toOperationJob(operationJobRowSchema.parse(row)));
    });
  }

  async listActive(limit = 50): Promise<OperationJob[]> {
    return this.engine.read((ctx) => {
      const rows = ctx.queryMany<Record<string, unknown>>(
        `
        SELECT id, job_type, status, payload_json, dedupe_key, created_by, source, trace_id,
               retry_count, max_retries, last_error, started_at, finished_at, created_at, updated_at
        FROM operation_jobs
        WHERE status IN ('pending', 'running')
        ORDER BY created_at ASC, id ASC
        LIMIT $limit;
        `,
        { $limit: Math.max(1, Math.min(500, limit)) },
      );
      return rows.map((row) => toOperationJob(operationJobRowSchema.parse(row)));
    });
  }

  async findRecentByDedupeKey(dedupeKey: string): Promise<OperationJob | null> {
    const dedupeCreatedAfter = new Date(Date.now() - OPERATION_DEDUPE_COOLDOWN_SECONDS * 1000).toISOString();
    return this.engine.read((ctx) => {
      const row = ctx.queryOne<Record<string, unknown>>(
        `
        SELECT id, job_type, status, payload_json, dedupe_key, created_by, source, trace_id,
               retry_count, max_retries, last_error, started_at, finished_at, created_at, updated_at
        FROM operation_jobs
        WHERE dedupe_key = $dedupeKey
          AND created_at >= $dedupeCreatedAfter
        ORDER BY created_at DESC, id DESC
        LIMIT 1;
        `,
        {
          $dedupeKey: dedupeKey,
          $dedupeCreatedAfter: dedupeCreatedAfter,
        },
      );
      if (!row) {
        return null;
      }
      return toOperationJob(operationJobRowSchema.parse(row));
    });
  }
}

function formatCancelReason(input: { operator?: string; reason?: string }) {
  const operator = input.operator?.trim() || "unknown";
  const reason = input.reason?.trim() || "manual_cancel";
  return `cancel_requested_by:${operator};reason=${reason}`;
}

function isCancelRequestedMessage(message: string | undefined): boolean {
  return typeof message === "string" && message.startsWith("cancel_requested_by:");
}

function toOperationJob(row: z.infer<typeof operationJobRowSchema>): OperationJob {
  const payload = parsePayloadJson(row.payload_json);
  const runtimeProgress = parseRuntimeProgress(payload[RUNTIME_PROGRESS_KEY]);
  const runtimeProgressEventCount = parseRuntimeProgressEventCount(payload[RUNTIME_PROGRESS_EVENT_COUNT_KEY]);
  return {
    id: row.id,
    jobType: row.job_type as OperationJobType,
    status: row.status as OperationJobStatus,
    payload,
    dedupeKey: row.dedupe_key ?? undefined,
    createdBy: row.created_by ?? undefined,
    source: row.source ?? undefined,
    traceId: row.trace_id ?? undefined,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    lastError: row.last_error ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runtimeProgress,
    runtimeProgressEventCount,
  };
}

function parsePayloadJson(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function getPayloadReportDate(payload: Record<string, unknown>): string | undefined {
  const raw = payload.reportDate;
  if (typeof raw !== "string") {
    return undefined;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

function parseRuntimeProgress(input: unknown): OperationRuntimeProgress | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const parsed = operationRuntimeProgressSchema.safeParse(input);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

function parseRuntimeProgressEventCount(input: unknown): number | undefined {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return undefined;
  }
  const rounded = Math.floor(input);
  return rounded >= 0 ? rounded : undefined;
}
