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
}

export interface WatchdogSummary {
  processed: number;
  published: number;
  skipped: number;
  failed: number;
  items: WatchdogItemResult[];
}

interface RunWatchdogInput {
  candidates: WatchdogCandidate[];
  dryRun: boolean;
  runRecheck: (candidate: WatchdogCandidate) => Promise<ReportState>;
  persistResult: (result: ReportState) => Promise<void>;
}

export async function runPendingWeeklyWatchdog(input: RunWatchdogInput): Promise<WatchdogSummary> {
  const summary: WatchdogSummary = {
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
      });
      continue;
    }

    if (action.type === "fail") {
      summary.failed += 1;
      summary.items.push({
        reportDate: candidate.reportDate,
        status: "failed",
        reason: action.reason,
      });
      continue;
    }

    try {
      const result = await input.runRecheck(candidate);
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
        });
      } else {
        summary.skipped += 1;
        summary.items.push({
          reportDate: candidate.reportDate,
          status: "processed",
          reason: input.dryRun ? "dry_run_still_pending" : "still_pending_after_recheck",
        });
      }
    } catch (error) {
      summary.failed += 1;
      summary.items.push({
        reportDate: candidate.reportDate,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}

function evaluateCandidate(artifact: ReviewArtifact): { type: "process" } | { type: "skip"; reason: string } | { type: "fail"; reason: string } {
  if (artifact.mode !== "weekly") {
    return { type: "skip", reason: "non_weekly_mode" };
  }

  if (artifact.publishStatus === "published") {
    return { type: "skip", reason: "already_published" };
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
};

