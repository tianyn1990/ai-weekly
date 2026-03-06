import dayjs from "dayjs";

import { applyRuntimeSourceOverrides, loadRuntimeConfig } from "../config/runtime-config.js";
import { loadSourceConfig } from "../config/source-config.js";
import { rankItemsWithTuning } from "../core/scoring.js";
import { createEmptyMetrics, createItemId, normalizeWhitespace, titleFingerprint } from "../core/utils.js";
import type { ItemCategory, NormalizedItem, RankedItem, ReportState, ReviewInstruction, SourceConfig } from "../core/types.js";
import { buildReportMarkdown } from "../report/markdown.js";
import { executeFeedbackRevision } from "../review/feedback-executor.js";
import { FileReviewInstructionStore } from "../review/instruction-store.js";
import { collectMockItems } from "../sources/mock-source.js";
import { collectRssItems } from "../sources/rss-source.js";
import { computeWeeklyReviewDeadline } from "../utils/time.js";
import { decideReviewAndPublish, resolvePendingStage } from "./review-policy.js";

export async function collectItemsNode(state: ReportState): Promise<Partial<ReportState>> {
  if (state.useMock) {
    // mock 模式用于学习与回归，保证在无网络或源不稳定时也能完整演练流程。
    const rawItems = collectMockItems(state.mode, state.generatedAt);
    const metrics = { ...state.metrics, collectedCount: rawItems.length };
    return { rawItems, metrics };
  }

  const runtimeConfig = await loadRuntimeConfig(state.runtimeConfigPath);
  const sources = applyRuntimeSourceOverrides(await loadSourceConfig(state.sourceConfigPath), runtimeConfig);
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
  const runtimeConfig = await loadRuntimeConfig(state.runtimeConfigPath);
  const sources = applyRuntimeSourceOverrides(await loadSourceConfig(state.sourceConfigPath), runtimeConfig);
  const ranked = rankItemsWithTuning(state.items, sources, state.generatedAt, {
    sourceWeightMultiplier: runtimeConfig.rankingWeights.source,
    freshnessMultiplier: runtimeConfig.rankingWeights.freshness,
    keywordMultiplier: runtimeConfig.rankingWeights.keyword,
    topicKeywords: runtimeConfig.topics,
    searchTermKeywords: runtimeConfig.searchTerms,
  });
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

export async function buildOutlineNode(state: ReportState): Promise<Partial<ReportState>> {
  return { outlineMarkdown: buildOutlineMarkdown(state.rankedItems, state.highlights) };
}

export function buildOutlineMarkdown(rankedItems: RankedItem[], highlights: RankedItem[]): string {
  // 大纲只提炼重点结构，便于先审方向再审细节，降低人工审核成本。
  const grouped = groupByCategory(rankedItems);
  const lines: string[] = [];

  lines.push("### 重点推荐（大纲）");
  for (const item of highlights.slice(0, 5)) {
    lines.push(`- ${item.title}`);
  }
  lines.push("");

  lines.push("### 分类覆盖（大纲）");
  for (const [category, items] of Object.entries(grouped)) {
    lines.push(`- ${category}: ${items.length} 条`);
  }

  return lines.join("\n");
}

export async function reviewOutlineNode(state: ReportState): Promise<Partial<ReportState>> {
  if (state.rejected) {
    return {};
  }
  if (state.mode === "daily") {
    return {
      outlineApproved: true,
      rejected: false,
      reviewStage: "none",
      reviewStatus: "not_required",
      reviewReason: "日报模式跳过大纲审核",
      reviewDeadlineAt: null,
    };
  }

  const reviewDeadlineAt = state.reviewDeadlineAt ?? computeWeeklyReviewDeadline(state.generatedAt, state.timezone);
  const decision = await resolveStageDecision({
    state,
    stage: "outline_review",
    fallbackApproved: state.approveOutline,
  });
  if (decision.action === "reject") {
    return buildRejectedResult("outline_review", decision.source, decision.reason);
  }

  if (decision.action === "request_revision") {
    const revised = await executeFeedbackRevision({
      mode: state.mode,
      generatedAt: state.generatedAt,
      sourceConfigPath: state.sourceConfigPath,
      runtimeConfigPath: state.runtimeConfigPath,
      rankedItems: state.rankedItems,
      metrics: state.metrics,
      instruction: decision.instruction,
    });
    return {
      rankedItems: revised.rankedItems,
      highlights: revised.highlights,
      metrics: revised.metrics,
      outlineMarkdown: buildOutlineMarkdown(revised.rankedItems, revised.highlights),
      outlineApproved: true,
      finalApproved: false,
      rejected: false,
      reviewDeadlineAt,
      reviewStage: "final_review",
      reviewStatus: "pending_review",
      reviewReason: `大纲阶段回流修订已执行（${decision.source}）`,
      revisionAuditLogs: [...state.revisionAuditLogs, revised.auditLog],
      ...(decision.warning ? { warnings: [...state.warnings, decision.warning] } : {}),
    };
  }

  const outlineApproved = decision.approved;

  return {
    outlineApproved,
    rejected: false,
    reviewDeadlineAt,
    reviewStage: outlineApproved ? "final_review" : "outline_review",
    reviewStatus: "pending_review",
    reviewReason: outlineApproved ? `大纲已通过（${decision.source}）` : `等待大纲审核（${decision.source}）`,
    ...(decision.warning ? { warnings: [...state.warnings, decision.warning] } : {}),
  };
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
    outlineMarkdown: state.outlineMarkdown,
    reviewStatus: state.reviewStatus,
    reviewStage: state.reviewStage,
    reviewDeadlineAt: state.reviewDeadlineAt,
    publishStatus: state.publishStatus,
    publishReason: state.publishReason,
    revisionAuditLogs: state.revisionAuditLogs,
  });

  return { reportMarkdown };
}

export async function reviewFinalNode(state: ReportState): Promise<Partial<ReportState>> {
  if (state.rejected) {
    return {};
  }
  if (state.mode === "daily") {
    return {
      finalApproved: true,
      rejected: false,
      reviewStage: "none",
      reviewStatus: "not_required",
      reviewReason: "日报模式跳过终稿审核",
    };
  }

  if (!state.outlineApproved) {
    return {
      finalApproved: false,
      rejected: false,
      reviewStage: "outline_review",
      reviewStatus: "pending_review",
      reviewReason: "大纲未通过，终稿审核尚未开始",
    };
  }

  const decision = await resolveStageDecision({
    state,
    stage: "final_review",
    fallbackApproved: state.approveFinal,
  });
  if (decision.action === "reject") {
    return buildRejectedResult("final_review", decision.source, decision.reason);
  }

  if (decision.action === "request_revision") {
    const revised = await executeFeedbackRevision({
      mode: state.mode,
      generatedAt: state.generatedAt,
      sourceConfigPath: state.sourceConfigPath,
      runtimeConfigPath: state.runtimeConfigPath,
      rankedItems: state.rankedItems,
      metrics: state.metrics,
      instruction: decision.instruction,
    });
    return {
      rankedItems: revised.rankedItems,
      highlights: revised.highlights,
      metrics: revised.metrics,
      outlineMarkdown: buildOutlineMarkdown(revised.rankedItems, revised.highlights),
      finalApproved: false,
      rejected: false,
      reviewStage: "final_review",
      reviewStatus: "pending_review",
      reviewReason: `终稿阶段回流修订已执行（${decision.source}）`,
      revisionAuditLogs: [...state.revisionAuditLogs, revised.auditLog],
      ...(decision.warning ? { warnings: [...state.warnings, decision.warning] } : {}),
    };
  }

  const finalApproved = decision.approved;
  return {
    finalApproved,
    rejected: false,
    reviewStage: finalApproved ? "none" : "final_review",
    reviewStatus: "pending_review",
    reviewReason: finalApproved ? `终稿审核已通过（${decision.source}）` : `等待终稿审核（${decision.source}）`,
    ...(decision.warning ? { warnings: [...state.warnings, decision.warning] } : {}),
  };
}

export async function publishOrWaitNode(state: ReportState): Promise<Partial<ReportState>> {
  // 发布决策统一集中在该节点，避免多个节点重复判定时间与状态。
  const decision = decideReviewAndPublish({
    mode: state.mode,
    generatedAt: state.generatedAt,
    reviewDeadlineAt: state.reviewDeadlineAt,
    outlineApproved: state.outlineApproved,
    finalApproved: state.finalApproved,
    rejected: state.rejected,
  });

  return {
    reviewStatus: decision.reviewStatus,
    reviewStage: decision.reviewStage,
    reviewReason: decision.reviewReason,
    publishStatus: decision.publishStatus,
    shouldPublish: decision.shouldPublish,
    publishReason: decision.publishReason,
    publishedAt: decision.publishedAt,
  };
}

export function createInitialState(params: {
  mode: ReportState["mode"];
  timezone: string;
  useMock: boolean;
  sourceConfigPath: string;
  runtimeConfigPath?: string;
  sourceLimit: number;
  generatedAt: string;
  reviewStartedAt?: string;
  reportDate: string;
  runId: string;
  approveOutline: boolean;
  approveFinal: boolean;
  reviewInstructionRoot: string;
}): ReportState {
  return {
    runId: params.runId,
    mode: params.mode,
    timezone: params.timezone,
    generatedAt: params.generatedAt,
    reviewStartedAt: params.reviewStartedAt ?? params.generatedAt,
    reportDate: params.reportDate,
    useMock: params.useMock,
    sourceConfigPath: params.sourceConfigPath,
    runtimeConfigPath: params.runtimeConfigPath ?? "outputs/runtime-config/global.json",
    sourceLimit: params.sourceLimit,
    reviewInstructionRoot: params.reviewInstructionRoot,
    rawItems: [],
    items: [],
    rankedItems: [],
    highlights: [],
    outlineMarkdown: "",
    reportMarkdown: "",
    approveOutline: params.approveOutline,
    approveFinal: params.approveFinal,
    outlineApproved: false,
    finalApproved: false,
    rejected: false,
    reviewStatus: params.mode === "daily" ? "not_required" : "pending_review",
    reviewStage: params.mode === "daily" ? "none" : "outline_review",
    reviewDeadlineAt: params.mode === "weekly" ? computeWeeklyReviewDeadline(params.generatedAt, params.timezone) : null,
    reviewReason: params.mode === "daily" ? "日报模式默认直出" : "等待审核",
    publishStatus: "pending",
    shouldPublish: false,
    publishedAt: null,
    publishReason: "not_decided",
    metrics: createEmptyMetrics(),
    revisionAuditLogs: [],
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

function groupByCategory(items: RankedItem[]): Record<string, RankedItem[]> {
  return items.reduce<Record<string, RankedItem[]>>((acc, item) => {
    if (!acc[item.category]) {
      acc[item.category] = [];
    }
    acc[item.category].push(item);
    return acc;
  }, {});
}

function resolveCategory(text: string): ItemCategory {
  const input = text.toLowerCase();

  // 分类规则按“工程实践优先”设计，优先识别开源、工具、研究与教程。
  if (/open source|开源|github|repo|license/.test(input)) return "open-source";
  if (/tool|sdk|framework|平台|workflow/.test(input)) return "tooling";
  if (/agent|agentic/.test(input)) return "agent";
  if (/paper|research|arxiv|benchmark|评测|研究/.test(input)) return "research";
  if (/news|融资|并购|发布|announcement|行业/.test(input)) return "industry-news";
  if (/tutorial|guide|实践|教程|how to/.test(input)) return "tutorial";
  return "other";
}

export async function loadEnabledSources(path: string, runtimeConfigPath = "outputs/runtime-config/global.json"): Promise<SourceConfig[]> {
  const runtimeConfig = await loadRuntimeConfig(runtimeConfigPath);
  const sources = applyRuntimeSourceOverrides(await loadSourceConfig(path), runtimeConfig);
  return sources.filter((source) => source.enabled);
}

// 供单元测试复用：便于验证审核阶段与发布判定是否符合预期。
export const __test__ = {
  resolvePendingStage,
};

async function resolveStageDecision(input: {
  state: ReportState;
  stage: "outline_review" | "final_review";
  fallbackApproved: boolean;
}): Promise<{
  approved: boolean;
  action?: "approve_outline" | "approve_final" | "request_revision" | "reject";
  reason?: string;
  instruction: ReviewInstruction;
  source: "persisted" | "cli_fallback";
  warning?: string;
}> {
  const { state, stage, fallbackApproved } = input;

  try {
    const store = new FileReviewInstructionStore(state.reviewInstructionRoot);
    const persistedInstruction = await store.getLatestInstruction({
      mode: state.mode,
      reportDate: state.reportDate,
      stage,
      decidedAfterOrAt: state.reviewStartedAt,
    });

    if (persistedInstruction !== null) {
      const approvedFromAction =
        persistedInstruction.action === "approve_outline" || persistedInstruction.action === "approve_final";
      return {
        approved: persistedInstruction.approved ?? approvedFromAction,
        action: persistedInstruction.action,
        reason: persistedInstruction.reason,
        instruction: persistedInstruction,
        source: "persisted",
      };
    }
  } catch (error) {
    // 指令文件异常时回退到 CLI，保证流程不中断；warning 会写入产物便于排障。
    return {
      approved: fallbackApproved,
      instruction: {
        mode: state.mode,
        reportDate: state.reportDate,
        stage,
        approved: fallbackApproved,
        decidedAt: state.generatedAt,
      },
      source: "cli_fallback",
      warning: `读取审核指令失败，已回退 CLI 参数（stage=${stage}）: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return {
    approved: fallbackApproved,
    instruction: {
      mode: state.mode,
      reportDate: state.reportDate,
      stage,
      approved: fallbackApproved,
      decidedAt: state.generatedAt,
    },
    source: "cli_fallback",
  };
}

function buildRejectedResult(stage: "outline_review" | "final_review", source: "persisted" | "cli_fallback", reason?: string) {
  return {
    rejected: true,
    outlineApproved: stage === "outline_review" ? false : undefined,
    finalApproved: stage === "final_review" ? false : undefined,
    reviewStage: "none" as const,
    reviewStatus: "rejected" as const,
    publishStatus: "pending" as const,
    shouldPublish: false,
    publishedAt: null,
    publishReason: "weekly_rejected_no_publish",
    reviewReason: reason ? `当前 run 被 reject（${source}）: ${reason}` : `当前 run 被 reject（${source}）`,
  };
}
