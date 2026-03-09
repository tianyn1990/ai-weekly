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
      quickDigest: [],
      itemSummaries: [],
      llmSummaryMeta: {
        enabled: false,
        inputCount: 0,
        summarizedCount: 0,
        fallbackTriggered: false,
      },
      highlights: [createItem("Agent Workflow 实战", "agent")],
      rankedItems: [createItem("Agent Workflow 实战", "agent"), createItem("Tool SDK 发布", "tooling")],
      metrics,
      outlineMarkdown: "### 重点推荐（大纲）\n- Agent 方向",
      reviewStatus: "pending_review",
      reviewStage: "outline_review",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      publishStatus: "pending",
      publishReason: "waiting_for_manual_review",
      revisionAuditLogs: [],
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
      quickDigest: [],
      itemSummaries: [],
      llmSummaryMeta: {
        enabled: false,
        inputCount: 0,
        summarizedCount: 0,
        fallbackTriggered: false,
      },
      highlights: [createItem("Agent Workflow 实战", "agent")],
      rankedItems: [createItem("Agent Workflow 实战", "agent")],
      metrics,
      outlineMarkdown: "### 重点推荐（大纲）\n- Agent 方向",
      reviewStatus: "approved",
      reviewStage: "none",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      publishStatus: "published",
      publishReason: "weekly_manual_approved",
      revisionAuditLogs: [],
    });

    expect(markdown).toContain("# AI 周报（已发布）");
    expect(markdown).not.toContain("待审核");
  });

  it("有导语与中文标题时应优先展示中文标题", () => {
    const metrics = createEmptyMetrics();
    const translatedItem: RankedItem = {
      ...createItem("LangGraph introduces orchestration", "agent"),
      titleZh: "LangGraph 发布编排能力",
    };
    const markdown = buildReportMarkdown({
      mode: "weekly",
      timezone: "Asia/Shanghai",
      generatedAt: "2026-03-09T02:00:00.000Z",
      quickDigest: [
        {
          itemId: translatedItem.id,
          title: translatedItem.title,
          takeaway: "重点摘要",
          evidenceItemIds: [translatedItem.id],
        },
      ],
      itemSummaries: [
        {
          itemId: translatedItem.id,
          title: translatedItem.title,
          titleZh: translatedItem.titleZh,
          summary: "逐条摘要",
          recommendation: "推荐理由",
          evidenceItemIds: [translatedItem.id],
          domainTag: "agent",
          intentTag: "release",
          actionability: 3,
        },
      ],
      leadSummary: "本期重点关注 Agent 编排能力与落地实践。",
      llmSummaryMeta: {
        enabled: true,
        inputCount: 1,
        summarizedCount: 1,
        fallbackTriggered: false,
      },
      highlights: [translatedItem],
      rankedItems: [translatedItem],
      metrics,
      outlineMarkdown: "### 重点推荐（大纲）\n- Agent 方向",
      reviewStatus: "pending_review",
      reviewStage: "outline_review",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      publishStatus: "pending",
      publishReason: "waiting_for_manual_review",
      revisionAuditLogs: [],
    });

    expect(markdown).toContain("## 本期导语");
    expect(markdown).toContain("LangGraph 发布编排能力 (LangGraph introduces orchestration)");
    expect(markdown).toContain("标签：agent / release | 可执行性=3");
    expect(markdown).toContain("证据：[LangGraph 发布编排能力 (LangGraph introduces orchestration)](https://example.com/item)");
  });
});
