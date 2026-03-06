import { describe, expect, it } from "vitest";

import type { ReviewArtifact } from "../src/core/review-artifact.js";
import { createEmptyMetrics } from "../src/core/utils.js";
import { isWeeklyReminderWindowReached, shouldSendWeeklyReminderForArtifact } from "../src/review/reminder-policy.js";

function createArtifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
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
    ...overrides,
  };
}

describe("reminder-policy", () => {
  it("周一 11:30 前不应触发提醒窗口", () => {
    const reached = isWeeklyReminderWindowReached("2026-03-09T03:29:00.000Z", "Asia/Shanghai");
    expect(reached).toBe(false);
  });

  it("周一 11:30 后应触发提醒窗口", () => {
    const reached = isWeeklyReminderWindowReached("2026-03-09T03:31:00.000Z", "Asia/Shanghai");
    expect(reached).toBe(true);
  });

  it("仅 pending 且未超截止的周报应发送提醒", () => {
    const shouldSend = shouldSendWeeklyReminderForArtifact(createArtifact(), "2026-03-09T03:40:00.000Z");
    expect(shouldSend).toBe(true);

    const published = shouldSendWeeklyReminderForArtifact(
      createArtifact({ publishStatus: "published", reviewStatus: "approved" }),
      "2026-03-09T03:40:00.000Z",
    );
    expect(published).toBe(false);

    const afterDeadline = shouldSendWeeklyReminderForArtifact(createArtifact(), "2026-03-09T04:40:00.000Z");
    expect(afterDeadline).toBe(false);
  });
});
