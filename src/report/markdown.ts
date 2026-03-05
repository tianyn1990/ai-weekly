import dayjs from "dayjs";

import type { PipelineMetrics, RankedItem, ReportMode } from "../core/types.js";
import { computeWeeklyReviewDeadline, formatHumanTime } from "../utils/time.js";

interface BuildMarkdownInput {
  mode: ReportMode;
  timezone: string;
  generatedAt: string;
  highlights: RankedItem[];
  rankedItems: RankedItem[];
  metrics: PipelineMetrics;
}

export function buildReportMarkdown(input: BuildMarkdownInput): string {
  const { mode, timezone, generatedAt, highlights, rankedItems, metrics } = input;
  const title = mode === "weekly" ? "AI 周报（待审核）" : "AI 日报（待审核）";
  const readableGeneratedAt = formatHumanTime(generatedAt, timezone);
  const reviewBlock =
    mode === "weekly"
      ? `- 审核截止：${formatHumanTime(computeWeeklyReviewDeadline(generatedAt, timezone), timezone)}（北京时间）\n- 规则：截止前未完成人工审核将自动发布当前版本。`
      : "- 日报默认无需强制审核，可直接发布或手动修订后发布。";

  const grouped = groupByCategory(rankedItems);

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`- 生成时间：${readableGeneratedAt}（${timezone}）`);
  lines.push(`- 覆盖条目：${rankedItems.length}`);
  lines.push(reviewBlock);
  lines.push("");

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
