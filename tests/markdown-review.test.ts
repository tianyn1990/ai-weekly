import { describe, expect, it } from "vitest";

import { createEmptyMetrics } from "../src/core/utils.js";
import type { RankedItem } from "../src/core/types.js";
import { buildReportMarkdown } from "../src/report/markdown.js";

function createItem(title: string, category: RankedItem["category"]): RankedItem {
  return {
    id: `${title}-id`,
    sourceId: "test-source",
    sourceName: "Test Source",
    title,
    link: "https://example.com/item",
    contentSnippet: "测试摘要",
    publishedAt: "2026-03-09T01:00:00.000Z",
    category,
    score: 88,
    importance: "high",
    recommendationReason: "测试推荐理由",
  };
}

describe("buildReportMarkdown", () => {
  it("周报应包含审核状态、发布状态和大纲内容", () => {
    const metrics = createEmptyMetrics();
    metrics.collectedCount = 2;
    metrics.normalizedCount = 2;
    metrics.dedupedCount = 2;
    metrics.highImportanceCount = 1;
    metrics.mediumImportanceCount = 1;
    metrics.categoryBreakdown.agent = 1;
    metrics.categoryBreakdown.tooling = 1;

    const markdown = buildReportMarkdown({
      mode: "weekly",
      timezone: "Asia/Shanghai",
      generatedAt: "2026-03-09T02:00:00.000Z",
      highlights: [createItem("Agent Workflow 实战", "agent")],
      rankedItems: [createItem("Agent Workflow 实战", "agent"), createItem("Tool SDK 发布", "tooling")],
      metrics,
      outlineMarkdown: "### 重点推荐（大纲）\n- Agent 方向",
      reviewStatus: "pending_review",
      reviewStage: "outline_review",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      publishStatus: "pending",
      publishReason: "waiting_for_manual_review",
    });

    expect(markdown).toContain("审核状态：pending_review");
    expect(markdown).toContain("当前审核阶段：outline_review");
    expect(markdown).toContain("发布状态：pending");
    expect(markdown).toContain("## 审核大纲");
    expect(markdown).toContain("Agent 方向");
  });

  it("审核通过发布后标题不应显示待审核文案", () => {
    const metrics = createEmptyMetrics();
    const markdown = buildReportMarkdown({
      mode: "weekly",
      timezone: "Asia/Shanghai",
      generatedAt: "2026-03-09T02:00:00.000Z",
      highlights: [createItem("Agent Workflow 实战", "agent")],
      rankedItems: [createItem("Agent Workflow 实战", "agent")],
      metrics,
      outlineMarkdown: "### 重点推荐（大纲）\n- Agent 方向",
      reviewStatus: "approved",
      reviewStage: "none",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      publishStatus: "published",
      publishReason: "weekly_manual_approved",
    });

    expect(markdown).toContain("# AI 周报（已发布）");
    expect(markdown).not.toContain("待审核");
  });
});
