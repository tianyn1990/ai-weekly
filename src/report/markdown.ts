import dayjs from "dayjs";

import type {
  CategoryLeadSummary,
  LlmItemSummary,
  LlmQuickDigestItem,
  LlmSummaryMeta,
  PipelineMetrics,
  PublishStatus,
  RankedItem,
  ReportMode,
  ReviewStage,
  ReviewStatus,
  RevisionAuditLog,
} from "../core/types.js";
import { formatHumanTime } from "../utils/time.js";

interface BuildMarkdownInput {
  mode: ReportMode;
  timezone: string;
  generatedAt: string;
  quickDigest: LlmQuickDigestItem[];
  itemSummaries: LlmItemSummary[];
  leadSummary?: string;
  categoryLeadSummaries?: CategoryLeadSummary[];
  llmSummaryMeta: LlmSummaryMeta;
  highlights: RankedItem[];
  rankedItems: RankedItem[];
  metrics: PipelineMetrics;
  outlineMarkdown: string;
  reviewStatus: ReviewStatus;
  reviewStage: ReviewStage;
  reviewDeadlineAt: string | null;
  publishStatus: PublishStatus;
  publishReason: string;
  revisionAuditLogs: RevisionAuditLog[];
}

export function buildReportMarkdown(input: BuildMarkdownInput): string {
  const {
    mode,
    timezone,
    generatedAt,
    quickDigest,
    itemSummaries,
    leadSummary,
    categoryLeadSummaries,
    llmSummaryMeta,
    highlights,
    rankedItems,
    metrics,
    outlineMarkdown,
    reviewStatus,
    reviewStage,
    reviewDeadlineAt,
    publishStatus,
    publishReason,
    revisionAuditLogs,
  } = input;

  const title = resolveReportTitle(mode, reviewStatus, publishStatus);
  const readableGeneratedAt = formatHumanTime(generatedAt, timezone);

  // 报告结构固定化，确保每期输出可比对、可检索、可自动审查。
  const grouped = groupByCategory(rankedItems);
  const evidenceItemMap = new Map(rankedItems.map((item) => [item.id, item]));

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`- 生成时间：${readableGeneratedAt}（${timezone}）`);
  lines.push(`- 覆盖条目：${rankedItems.length}`);
  lines.push(`- 审核状态：${reviewStatus}`);
  lines.push(`- 当前审核阶段：${reviewStage}`);
  if (reviewDeadlineAt) {
    lines.push(`- 审核截止：${formatHumanTime(reviewDeadlineAt, timezone)}（北京时间）`);
  }
  lines.push(`- 发布状态：${publishStatus}`);
  lines.push(`- 发布原因：${publishReason}`);
  if (llmSummaryMeta.enabled) {
    lines.push(`- LLM 总结：${llmSummaryMeta.fallbackTriggered ? "已回退规则摘要" : "已启用（MiniMax）"}`);
  } else {
    lines.push("- LLM 总结：未启用");
  }
  lines.push("");

  if (leadSummary && leadSummary.trim()) {
    lines.push("## 本期导语");
    lines.push("");
    lines.push(`- ${leadSummary.trim()}`);
    lines.push("");
  }

  lines.push("## 3 分钟速览");
  lines.push("");
  if (quickDigest.length === 0) {
    lines.push("- 暂无可用重点摘要。");
  } else {
    for (const digest of quickDigest) {
      const displayTitle = resolveDisplayTitleById(rankedItems, digest.itemId, digest.title);
      lines.push(`- ${displayTitle}`);
      lines.push(`  - 重点：${digest.takeaway}`);
      lines.push(`  - 证据：${formatEvidenceRefs(digest.evidenceItemIds, evidenceItemMap)}`);
    }
  }
  if (llmSummaryMeta.fallbackTriggered) {
    lines.push(`- 说明：LLM 总结失败，已自动回退规则摘要（${llmSummaryMeta.fallbackReason ?? "unknown"}）`);
  }
  lines.push("");

  if (itemSummaries.length > 0) {
    lines.push("## 逐条摘要");
    lines.push("");
    for (const summary of itemSummaries) {
      const displayTitle = resolveDisplayTitleById(rankedItems, summary.itemId, summary.title);
      lines.push(`- ${displayTitle}`);
      lines.push(`  - 摘要：${summary.summary}`);
      lines.push(`  - 推荐：${summary.recommendation}`);
      if (summary.domainTag || summary.intentTag || typeof summary.actionability === "number") {
        const tags = [summary.domainTag, summary.intentTag].filter(Boolean).join(" / ");
        const actionability = typeof summary.actionability === "number" ? ` | 可执行性=${summary.actionability}` : "";
        lines.push(`  - 标签：${tags || "unknown"}${actionability}`);
      }
      lines.push(`  - 证据：${formatEvidenceRefs(summary.evidenceItemIds, evidenceItemMap)}`);
    }
    lines.push("");
  }

  if (revisionAuditLogs.length > 0) {
    lines.push("## 回流修订记录");
    lines.push("");
    for (const log of revisionAuditLogs) {
      lines.push(
        `- ${formatHumanTime(log.at, timezone)} | stage=${log.stage} | operator=${log.operator ?? "unknown"} | before=${log.beforeCount} | after=${log.afterCount} | +${log.addedCount}/-${log.removedCount}`,
      );
      if (log.globalConfigChanges.length > 0) {
        lines.push(`  - 全局配置变更：${log.globalConfigChanges.join(", ")}`);
      }
      if (log.reason) {
        lines.push(`  - 审核原因：${log.reason}`);
      }
      if (log.notes) {
        lines.push(`  - 备注：${log.notes}`);
      }
    }
    lines.push("");
  }

  if (mode === "weekly") {
    lines.push("## 审核大纲");
    lines.push("");
    lines.push(outlineMarkdown || "- 尚未生成大纲");
    lines.push("");
  }

  lines.push("## 重点推荐");
  lines.push("");
  for (const item of highlights) {
    lines.push(`- [${resolveDisplayTitle(item)}](${item.link})`);
    lines.push(`  - 重要级别：${item.importance} | 评分：${item.score}`);
    lines.push(`  - 推荐理由：${item.recommendationReason}`);
  }
  lines.push("");

  if (categoryLeadSummaries && categoryLeadSummaries.length > 0) {
    lines.push("## 分类导读");
    lines.push("");
    for (const summary of categoryLeadSummaries) {
      lines.push(`- ${summary.category}：${summary.lead}`);
      if (summary.fallbackTriggered) {
        lines.push(`  - 说明：该导读使用模板回退（${summary.reason ?? "unknown"}）`);
      }
    }
    lines.push("");
  }

  lines.push("## 分类正文");
  lines.push("");
  for (const [category, items] of Object.entries(grouped)) {
    if (items.length === 0) continue;
    lines.push(`### ${category}`);
    lines.push("");
    for (const item of items) {
      const publishedAt = dayjs(item.publishedAt).tz(timezone).format("YYYY-MM-DD HH:mm");
      lines.push(`- [${resolveDisplayTitle(item)}](${item.link})`);
      lines.push(`  - 来源：${item.sourceName} | 发布时间：${publishedAt}`);
      lines.push(`  - 评分：${item.score} | 推荐级别：${item.importance}`);
      lines.push(`  - 摘要：${shorten(item.contentSnippet, 140)}`);
    }
    lines.push("");
  }

  // 运行指标直接落盘，便于后续接入质量门禁与 Dashboard。
  lines.push("## 运行指标");
  lines.push("");
  lines.push(`- 采集条目数：${metrics.collectedCount}`);
  lines.push(`- 标准化条目数：${metrics.normalizedCount}`);
  lines.push(`- 去重后条目数：${metrics.dedupedCount}`);
  lines.push(
    `- 推荐级别分布：high=${metrics.highImportanceCount}, medium=${metrics.mediumImportanceCount}, low=${metrics.lowImportanceCount}`,
  );
  lines.push(
    `- 分类分布：${Object.entries(metrics.categoryBreakdown)
      .map(([category, count]) => `${category}:${count}`)
      .join(", ")}`,
  );

  return lines.join("\n");
}

function resolveReportTitle(mode: ReportMode, reviewStatus: ReviewStatus, publishStatus: PublishStatus): string {
  if (mode === "daily") {
    return publishStatus === "published" ? "AI 日报（已发布）" : "AI 日报（待发布）";
  }

  if (reviewStatus === "approved" && publishStatus === "published") {
    return "AI 周报（已发布）";
  }

  if (reviewStatus === "timeout_published") {
    return "AI 周报（超时自动发布）";
  }

  if (reviewStatus === "rejected") {
    return "AI 周报（已拒绝）";
  }

  return "AI 周报（待审核）";
}

function groupByCategory(items: RankedItem[]): Record<string, RankedItem[]> {
  return items.reduce<Record<string, RankedItem[]>>((acc, item) => {
    const category = item.category;
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(item);
    return acc;
  }, {});
}

function shorten(input: string, max: number): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max - 1)}…`;
}

function resolveDisplayTitle(item: Pick<RankedItem, "title" | "titleZh">): string {
  if (!item.titleZh) {
    return item.title;
  }
  const titleZh = item.titleZh.trim();
  if (!titleZh || titleZh === item.title) {
    return item.title;
  }
  return `${titleZh} (${item.title})`;
}

function resolveDisplayTitleById(items: RankedItem[], itemId: string | undefined, fallbackTitle: string): string {
  if (!itemId) {
    return fallbackTitle;
  }
  const matched = items.find((item) => item.id === itemId);
  if (!matched) {
    return fallbackTitle;
  }
  return resolveDisplayTitle(matched);
}

function formatEvidenceRefs(evidenceItemIds: string[], evidenceItemMap: Map<string, RankedItem>): string {
  if (evidenceItemIds.length === 0) {
    return "无";
  }

  const refs = Array.from(new Set(evidenceItemIds)).map((id) => {
    const matched = evidenceItemMap.get(id);
    if (!matched) {
      // 历史产物可能存在无法映射的证据 id，保留原值便于排查。
      return id;
    }
    return `[${resolveDisplayTitle(matched)}](${matched.link})`;
  });

  return refs.join(" | ");
}
