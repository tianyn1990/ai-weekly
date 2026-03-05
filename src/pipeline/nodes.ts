import dayjs from "dayjs";

import { loadSourceConfig } from "../config/source-config.js";
import { rankItems } from "../core/scoring.js";
import { createEmptyMetrics, createItemId, normalizeWhitespace, titleFingerprint } from "../core/utils.js";
import type { ItemCategory, NormalizedItem, RankedItem, ReportState, SourceConfig } from "../core/types.js";
import { buildReportMarkdown } from "../report/markdown.js";
import { collectMockItems } from "../sources/mock-source.js";
import { collectRssItems } from "../sources/rss-source.js";

export async function collectItemsNode(state: ReportState): Promise<Partial<ReportState>> {
  const sources = await loadSourceConfig(state.sourceConfigPath);

  if (state.useMock) {
    // mock 模式用于学习与回归，保证在无网络或源不稳定时也能完整演练流程。
    const rawItems = collectMockItems(state.mode, state.generatedAt);
    const metrics = { ...state.metrics, collectedCount: rawItems.length };
    return { rawItems, metrics };
  }

  const { items, warnings } = await collectRssItems(sources, state.sourceLimit);
  const metrics = { ...state.metrics, collectedCount: items.length };
  return { rawItems: items, metrics, warnings };
}

export async function normalizeItemsNode(state: ReportState): Promise<Partial<ReportState>> {
  // 标准化阶段统一字段与时间，避免后续评分/分类逻辑处理多种脏格式。
  const items: NormalizedItem[] = state.rawItems.map((item) => {
    const title = normalizeWhitespace(item.title || "(无标题)");
    const snippet = normalizeWhitespace(item.contentSnippet || "");
    const link = normalizeWhitespace(item.link);
    const publishedAt = dayjs(item.publishedAt).isValid() ? dayjs(item.publishedAt).toISOString() : state.generatedAt;

    return {
      id: createItemId(`${item.sourceId}-${link}-${title}`),
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      title,
      link,
      contentSnippet: snippet,
      publishedAt,
      category: "other",
    };
  });

  const metrics = { ...state.metrics, normalizedCount: items.length };
  return { items, metrics };
}

export async function dedupeItemsNode(state: ReportState): Promise<Partial<ReportState>> {
  const seen = new Set<string>();
  const deduped: NormalizedItem[] = [];

  for (const item of state.items) {
    // 先用 link + title fingerprint 去重，后续可升级为 embedding 相似度去重。
    const key = `${item.link}|${titleFingerprint(item.title)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  const metrics = { ...state.metrics, dedupedCount: deduped.length };
  return { items: deduped, metrics };
}

export async function classifyItemsNode(state: ReportState): Promise<Partial<ReportState>> {
  // 首版采用规则分类，确保可解释性；后续可替换为 LLM 分类节点。
  const items = state.items.map((item) => ({ ...item, category: resolveCategory(`${item.title} ${item.contentSnippet}`) }));

  return { items };
}

export async function rankItemsNode(state: ReportState): Promise<Partial<ReportState>> {
  const sources = await loadSourceConfig(state.sourceConfigPath);
  const ranked = rankItems(state.items, sources, state.generatedAt);
  // highlights 用于报告顶部“重点推荐”，和“全覆盖正文”区分展示层次。
  const highlights = pickHighlights(ranked, state.mode);

  const metrics = {
    ...state.metrics,
    highImportanceCount: ranked.filter((item) => item.importance === "high").length,
    mediumImportanceCount: ranked.filter((item) => item.importance === "medium").length,
    lowImportanceCount: ranked.filter((item) => item.importance === "low").length,
    categoryBreakdown: buildCategoryBreakdown(ranked),
  };

  return { rankedItems: ranked, highlights, metrics };
}

export async function buildReportNode(state: ReportState): Promise<Partial<ReportState>> {
  // 输出节点只负责渲染，不再改写 ranking 结果，保持数据流单向清晰。
  const reportMarkdown = buildReportMarkdown({
    mode: state.mode,
    timezone: state.timezone,
    generatedAt: state.generatedAt,
    highlights: state.highlights,
    rankedItems: state.rankedItems,
    metrics: state.metrics,
  });

  return { reportMarkdown };
}

export function createInitialState(params: {
  mode: ReportState["mode"];
  timezone: string;
  useMock: boolean;
  sourceConfigPath: string;
  sourceLimit: number;
  generatedAt: string;
  runId: string;
}): ReportState {
  return {
    runId: params.runId,
    mode: params.mode,
    timezone: params.timezone,
    generatedAt: params.generatedAt,
    useMock: params.useMock,
    sourceConfigPath: params.sourceConfigPath,
    sourceLimit: params.sourceLimit,
    rawItems: [],
    items: [],
    rankedItems: [],
    highlights: [],
    reportMarkdown: "",
    metrics: createEmptyMetrics(),
    warnings: [],
  };
}

function buildCategoryBreakdown(items: RankedItem[]): Record<ItemCategory, number> {
  const breakdown = createEmptyMetrics().categoryBreakdown;
  for (const item of items) {
    breakdown[item.category] += 1;
  }
  return breakdown;
}

function pickHighlights(items: RankedItem[], mode: ReportState["mode"]): RankedItem[] {
  const limit = mode === "weekly" ? 8 : 5;
  return items.slice(0, limit);
}

function resolveCategory(text: string): ItemCategory {
  const input = text.toLowerCase();

  // 分类规则按“工程实践优先”设计，优先识别开源、工具、研究与教程。
  if (/open source|开源|github|repo|license/.test(input)) return "open-source";
  if (/tool|sdk|framework|平台|workflow|agent/.test(input)) return "tooling";
  if (/paper|research|arxiv|benchmark|评测|研究/.test(input)) return "research";
  if (/news|融资|并购|发布|announcement|行业/.test(input)) return "industry-news";
  if (/tutorial|guide|实践|教程|how to/.test(input)) return "tutorial";
  return "other";
}

export async function loadEnabledSources(path: string): Promise<SourceConfig[]> {
  const sources = await loadSourceConfig(path);
  return sources.filter((source) => source.enabled);
}
