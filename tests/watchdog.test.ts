import { describe, expect, it, vi } from "vitest";

import { createEmptyMetrics } from "../src/core/utils.js";
import type { ReviewArtifact } from "../src/core/review-artifact.js";
import { createInitialState } from "../src/pipeline/nodes.js";
import { __test__, runPendingWeeklyWatchdog } from "../src/pipeline/watchdog.js";

function createReviewArtifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  const base: ReviewArtifact = {
    runId: "test-run",
    generatedAt: "2026-03-09T01:00:00.000Z",
    reportDate: "2026-03-09",
    mode: "weekly",
    reviewStatus: "pending_review",
    reviewStage: "outline_review",
    reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
    reviewReason: "等待审核",
    publishStatus: "pending",
    shouldPublish: false,
    publishReason: "waiting_for_manual_review",
    publishedAt: null,
    outlineApproved: false,
    finalApproved: false,
    metrics: createEmptyMetrics(),
    highlights: [],
    warnings: [],
    snapshot: {
      timezone: "Asia/Shanghai",
      sourceConfigPath: "data/sources.yaml",
      sourceLimit: 6,
      outlineMarkdown: "### 重点推荐（大纲）",
      rankedItems: [],
      highlights: [],
      metrics: createEmptyMetrics(),
      warnings: [],
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
    },
  };

  return { ...base, ...overrides };
}

function createRecheckResult(shouldPublish: boolean) {
  const state = createInitialState({
    mode: "weekly",
    timezone: "Asia/Shanghai",
    useMock: false,
    sourceConfigPath: "data/sources.yaml",
    sourceLimit: 6,
    generatedAt: "2026-03-09T05:00:00.000Z",
    reportDate: "2026-03-09",
    runId: "test-recheck",
    approveOutline: false,
    approveFinal: false,
    reviewInstructionRoot: "outputs/review-instructions",
  });

  return {
    ...state,
    shouldPublish,
    publishStatus: shouldPublish ? ("published" as const) : ("pending" as const),
    publishReason: shouldPublish ? "weekly_timeout_auto_publish" : "waiting_for_manual_review",
    reviewStatus: shouldPublish ? ("timeout_published" as const) : ("pending_review" as const),
  };
}

describe("watchdog", () => {
  it("已发布报告应被跳过", () => {
    const action = __test__.evaluateCandidate(
      createReviewArtifact({
        reviewStatus: "approved",
        publishStatus: "published",
      }),
    );
    expect(action).toEqual({ type: "skip", reason: "already_published" });
  });

  it("dry-run 模式不应调用持久化写入", async () => {
    const persistSpy = vi.fn(async () => {});
    const summary = await runPendingWeeklyWatchdog({
      candidates: [{ reportDate: "2026-03-09", artifact: createReviewArtifact() }],
      dryRun: true,
      runRecheck: async () => createRecheckResult(true),
      persistResult: persistSpy,
    });

    expect(persistSpy).not.toHaveBeenCalled();
    expect(summary.processed).toBe(1);
    expect(summary.published).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it("复检后仍 pending 的报告应计入 skipped", async () => {
    const persistSpy = vi.fn(async () => {});
    const summary = await runPendingWeeklyWatchdog({
      candidates: [{ reportDate: "2026-03-09", artifact: createReviewArtifact() }],
      dryRun: false,
      runRecheck: async () => createRecheckResult(false),
      persistResult: persistSpy,
    });

    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(summary.processed).toBe(1);
    expect(summary.published).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.items[0]?.status).toBe("processed");
  });

  it("缺少 snapshot 的 pending 报告应计入 failed", async () => {
    const summary = await runPendingWeeklyWatchdog({
      candidates: [{ reportDate: "2026-03-09", artifact: createReviewArtifact({ snapshot: undefined }) }],
      dryRun: false,
      runRecheck: async () => createRecheckResult(true),
      persistResult: async () => {},
    });

    expect(summary.processed).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.items[0]?.reason).toBe("missing_snapshot");
  });
});

