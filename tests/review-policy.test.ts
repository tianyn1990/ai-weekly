import { describe, expect, it } from "vitest";

import { decideReviewAndPublish, resolvePendingStage } from "../src/pipeline/review-policy.js";

describe("review-policy", () => {
  it("日报应直接发布且不需要审核", () => {
    const result = decideReviewAndPublish({
      mode: "daily",
      generatedAt: "2026-03-09T01:00:00.000Z",
      reviewDeadlineAt: null,
      outlineApproved: false,
      finalApproved: false,
      rejected: false,
    });

    expect(result.reviewStatus).toBe("not_required");
    expect(result.publishStatus).toBe("published");
    expect(result.shouldPublish).toBe(true);
    expect(result.publishReason).toBe("daily_direct_publish");
  });

  it("周报在审核窗口内且未通过终稿审核时应保持 pending_review", () => {
    const result = decideReviewAndPublish({
      mode: "weekly",
      generatedAt: "2026-03-09T01:30:00.000Z",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      outlineApproved: true,
      finalApproved: false,
      rejected: false,
    });

    expect(result.reviewStatus).toBe("pending_review");
    expect(result.reviewStage).toBe("final_review");
    expect(result.shouldPublish).toBe(false);
  });

  it("周报超过截止时间且未通过审核时应 timeout 自动发布", () => {
    const result = decideReviewAndPublish({
      mode: "weekly",
      generatedAt: "2026-03-09T05:00:00.000Z",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      outlineApproved: false,
      finalApproved: false,
      rejected: false,
    });

    expect(result.reviewStatus).toBe("timeout_published");
    expect(result.publishStatus).toBe("published");
    expect(result.shouldPublish).toBe(true);
    expect(result.publishReason).toBe("weekly_timeout_auto_publish");
  });

  it("周报在截止前双重审核通过应立即发布", () => {
    const result = decideReviewAndPublish({
      mode: "weekly",
      generatedAt: "2026-03-09T02:00:00.000Z",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      outlineApproved: true,
      finalApproved: true,
      rejected: false,
    });

    expect(result.reviewStatus).toBe("approved");
    expect(result.reviewStage).toBe("none");
    expect(result.shouldPublish).toBe(true);
    expect(result.publishReason).toBe("weekly_manual_approved");
  });

  it("待审核阶段应根据 outline/final 状态返回正确节点", () => {
    expect(resolvePendingStage(false, false)).toBe("final_review");
    expect(resolvePendingStage(true, false)).toBe("final_review");
    expect(resolvePendingStage(true, true)).toBe("none");
  });

  it("reject 后当前 run 不应再发布", () => {
    const result = decideReviewAndPublish({
      mode: "weekly",
      generatedAt: "2026-03-09T05:00:00.000Z",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      outlineApproved: true,
      finalApproved: false,
      rejected: true,
    });

    expect(result.reviewStatus).toBe("rejected");
    expect(result.publishStatus).toBe("pending");
    expect(result.shouldPublish).toBe(false);
    expect(result.publishReason).toBe("weekly_rejected_no_publish");
  });
});
