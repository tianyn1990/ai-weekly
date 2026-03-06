import type { ReviewArtifact } from "../core/review-artifact.js";
import type { ReportState } from "../core/types.js";

export interface WatchdogCandidate {
  reportDate: string;
  artifact: ReviewArtifact;
}

export interface WatchdogItemResult {
  reportDate: string;
  status: "published" | "processed" | "skipped" | "failed";
  reason: string;
  attempts: number;
}

export interface WatchdogSummary {
  startedAt: string;
  finishedAt: string;
  processed: number;
  published: number;
  skipped: number;
  failed: number;
  items: WatchdogItemResult[];
}

interface RunWatchdogInput {
  candidates: WatchdogCandidate[];
  dryRun: boolean;
  maxRetries: number;
  retryDelayMs: number;
  runRecheck: (candidate: WatchdogCandidate) => Promise<ReportState>;
  persistResult: (result: ReportState) => Promise<void>;
  onRetry?: (params: { reportDate: string; attempt: number; maxRetries: number; error: unknown }) => void;
}

export async function runPendingWeeklyWatchdog(input: RunWatchdogInput): Promise<WatchdogSummary> {
  const startedAt = new Date().toISOString();
  const summary: WatchdogSummary = {
    startedAt,
    finishedAt: startedAt,
    processed: 0,
    published: 0,
    skipped: 0,
    failed: 0,
    items: [],
  };

  for (const candidate of input.candidates) {
    const action = evaluateCandidate(candidate.artifact);
    if (action.type === "skip") {
      summary.skipped += 1;
      summary.items.push({
        reportDate: candidate.reportDate,
        status: "skipped",
        reason: action.reason,
        attempts: 0,
      });
      continue;
    }

    if (action.type === "fail") {
      summary.failed += 1;
      summary.items.push({
        reportDate: candidate.reportDate,
        status: "failed",
        reason: action.reason,
        attempts: 0,
      });
      continue;
    }

    try {
      const execution = await runRecheckWithRetry({
        candidate,
        maxRetries: input.maxRetries,
        retryDelayMs: input.retryDelayMs,
        runRecheck: input.runRecheck,
        onRetry: input.onRetry,
      });
      const result = execution.result;
      summary.processed += 1;

      if (!input.dryRun) {
        await input.persistResult(result);
      }

      if (result.shouldPublish) {
        summary.published += 1;
        summary.items.push({
          reportDate: candidate.reportDate,
          status: "published",
          reason: input.dryRun ? "dry_run_would_publish" : result.publishReason,
          attempts: execution.attempts,
        });
      } else {
        summary.skipped += 1;
        summary.items.push({
          reportDate: candidate.reportDate,
          status: "processed",
          reason: result.reviewStatus === "rejected" ? "rejected_run" : input.dryRun ? "dry_run_still_pending" : "still_pending_after_recheck",
          attempts: execution.attempts,
        });
      }
    } catch (error) {
      const failedAttempts = error instanceof RetryExhaustedError ? error.attempts : 1;
      summary.failed += 1;
      summary.items.push({
        reportDate: candidate.reportDate,
        status: "failed",
        reason: error instanceof RetryExhaustedError ? error.lastErrorMessage : error instanceof Error ? error.message : String(error),
        attempts: failedAttempts,
      });
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

function evaluateCandidate(artifact: ReviewArtifact): { type: "process" } | { type: "skip"; reason: string } | { type: "fail"; reason: string } {
  if (artifact.mode !== "weekly") {
    return { type: "skip", reason: "non_weekly_mode" };
  }

  if (artifact.publishStatus === "published") {
    return { type: "skip", reason: "already_published" };
  }

  if (artifact.reviewStatus === "rejected" || artifact.rejected) {
    return { type: "skip", reason: "rejected_run" };
  }

  if (artifact.reviewStatus !== "pending_review" || artifact.publishStatus !== "pending") {
    return { type: "skip", reason: "not_pending_review" };
  }

  // 复检依赖 snapshot 重建状态；缺失时无法保证“发布即审核版本”一致性。
  if (!artifact.snapshot) {
    return { type: "fail", reason: "missing_snapshot" };
  }

  return { type: "process" };
}

export const __test__ = {
  evaluateCandidate,
  runRecheckWithRetry,
};

async function runRecheckWithRetry(input: {
  candidate: WatchdogCandidate;
  maxRetries: number;
  retryDelayMs: number;
  runRecheck: (candidate: WatchdogCandidate) => Promise<ReportState>;
  onRetry?: (params: { reportDate: string; attempt: number; maxRetries: number; error: unknown }) => void;
}): Promise<{ result: ReportState; attempts: number }> {
  const maxRetries = Math.max(0, input.maxRetries);
  let attempts = 0;
  let lastError: unknown;

  while (attempts <= maxRetries) {
    attempts += 1;
    try {
      const result = await input.runRecheck(input.candidate);
      return { result, attempts };
    } catch (error) {
      lastError = error;
      const canRetry = attempts <= maxRetries;
      if (!canRetry) {
        break;
      }

      // 重试日志由调用方控制，避免在核心逻辑中硬编码输出介质。
      input.onRetry?.({
        reportDate: input.candidate.reportDate,
        attempt: attempts,
        maxRetries,
        error,
      });
      await sleep(input.retryDelayMs);
    }
  }

  throw new RetryExhaustedError(attempts, lastError);
}

function sleep(ms: number): Promise<void> {
  const delay = Math.max(0, ms);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

class RetryExhaustedError extends Error {
  attempts: number;
  lastErrorMessage: string;

  constructor(attempts: number, lastError: unknown) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    super(`watchdog_recheck_failed_after_retries:${message}`);
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.lastErrorMessage = message;
  }
}
