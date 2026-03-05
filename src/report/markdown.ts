import dayjs from "dayjs";

import type { PipelineMetrics, PublishStatus, RankedItem, ReportMode, ReviewStage, ReviewStatus } from "../core/types.js";
import { formatHumanTime } from "../utils/time.js";

interface BuildMarkdownInput {
  mode: ReportMode;
  timezone: string;
  generatedAt: string;
  highlights: RankedItem[];
  rankedItems: RankedItem[];
  metrics: PipelineMetrics;
  outlineMarkdown: string;
  reviewStatus: ReviewStatus;
  reviewStage: ReviewStage;
  reviewDeadlineAt: string | null;
  publishStatus: PublishStatus;
  publishReason: string;
}

export function buildReportMarkdown(input: BuildMarkdownInput): string {
  const {
    mode,
    timezone,
    generatedAt,
    highlights,
    rankedItems,
    metrics,
    outlineMarkdown,
    reviewStatus,
    reviewStage,
    reviewDeadlineAt,
    publishStatus,
    publishReason,
  } = input;

  const title = resolveReportTitle(mode, reviewStatus, publishStatus);
  const readableGeneratedAt = formatHumanTime(generatedAt, timezone);

  // 报告结构固定化，确保每期输出可比对、可检索、可自动审查。
  const grouped = groupByCategory(rankedItems);

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
  lines.push("");

  if (mode === "weekly") {
    lines.push("## 审核大纲");
    lines.push("");
    lines.push(outlineMarkdown || "- 尚未生成大纲");
    lines.push("");
  }

  lines.push("## 重点推荐");
  lines.push("");
  for (const item of highlights) {
    lines.push(`- [${item.title}](${item.link})`);
    lines.push(`  - 重要级别：${item.importance} | 评分：${item.score}`);
    lines.push(`  - 推荐理由：${item.recommendationReason}`);
  }
  lines.push("");

  lines.push("## 分类正文");
  lines.push("");
  for (const [category, items] of Object.entries(grouped)) {
    if (items.length === 0) continue;
    lines.push(`### ${category}`);
    lines.push("");
    for (const item of items) {
      const publishedAt = dayjs(item.publishedAt).tz(timezone).format("YYYY-MM-DD HH:mm");
      lines.push(`- [${item.title}](${item.link})`);
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
