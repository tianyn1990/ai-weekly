import dayjs from "dayjs";

import type { PublishStatus, ReportMode, ReviewStage, ReviewStatus } from "../core/types.js";

export interface ReviewPolicyInput {
  mode: ReportMode;
  generatedAt: string;
  reviewDeadlineAt: string | null;
  outlineApproved: boolean;
  finalApproved: boolean;
  rejected: boolean;
}

export interface ReviewPolicyResult {
  reviewStatus: ReviewStatus;
  reviewStage: ReviewStage;
  publishStatus: PublishStatus;
  shouldPublish: boolean;
  reviewReason: string;
  publishReason: string;
  publishedAt: string | null;
}

export function decideReviewAndPublish(input: ReviewPolicyInput): ReviewPolicyResult {
  const { mode, generatedAt, reviewDeadlineAt, outlineApproved, finalApproved, rejected } = input;

  if (mode === "daily") {
    // 日报采用直出策略，不引入人工审核阻塞。
    return {
      reviewStatus: "not_required",
      reviewStage: "none",
      publishStatus: "published",
      shouldPublish: true,
      reviewReason: "日报默认不强制审核",
      publishReason: "daily_direct_publish",
      publishedAt: generatedAt,
    };
  }

  const deadlineReached = isDeadlineReached(generatedAt, reviewDeadlineAt);

  if (rejected) {
    // reject 表示当前 run 被终止，不允许继续发布；后续需新建 run。
    return {
      reviewStatus: "rejected",
      reviewStage: "none",
      publishStatus: "pending",
      shouldPublish: false,
      reviewReason: "当前 run 已被 reject，必须新建 run 才能再次发布",
      publishReason: "weekly_rejected_no_publish",
      publishedAt: null,
    };
  }

  if (finalApproved) {
    // M5.5 起周报改为单阶段终稿审核：只要终稿通过即可发布。
    return {
      reviewStatus: "approved",
      reviewStage: "none",
      publishStatus: "published",
      shouldPublish: true,
      reviewReason: "大纲与终稿均已人工审核通过",
      publishReason: "weekly_manual_approved",
      publishedAt: generatedAt,
    };
  }

  if (deadlineReached) {
    // 超过周一 12:30 仍未完成审核时，按业务规则自动发布当前版本。
    return {
      reviewStatus: "timeout_published",
      reviewStage: resolvePendingStage(outlineApproved, finalApproved),
      publishStatus: "published",
      shouldPublish: true,
      reviewReason: "超过周一 12:30 审核截止时间，触发自动发布",
      publishReason: "weekly_timeout_auto_publish",
      publishedAt: generatedAt,
    };
  }

  return {
    // 审核窗口内未满足发布条件时，维持 pending_review 并等待人工动作。
    reviewStatus: "pending_review",
    reviewStage: resolvePendingStage(outlineApproved, finalApproved),
    publishStatus: "pending",
    shouldPublish: false,
    reviewReason: "仍在审核窗口内，等待人工审核",
    publishReason: "waiting_for_manual_review",
    publishedAt: null,
  };
}

export function resolvePendingStage(outlineApproved: boolean, finalApproved: boolean): ReviewStage {
  // 兼容保留 outlineApproved 入参，但在单阶段模型下仅以 finalApproved 判定待审阶段。
  void outlineApproved;
  return finalApproved ? "none" : "final_review";
}

function isDeadlineReached(generatedAt: string, reviewDeadlineAt: string | null): boolean {
  if (!reviewDeadlineAt) {
    return false;
  }

  return dayjs(generatedAt).isSame(dayjs(reviewDeadlineAt)) || dayjs(generatedAt).isAfter(dayjs(reviewDeadlineAt));
}
