import dayjs from "dayjs";

import { DbAuditStore } from "../audit/audit-store.js";
import { applyRuntimeSourceOverrides, createRuntimeConfigStore } from "../config/runtime-config.js";
import { loadSourceConfig } from "../config/source-config.js";
import { rankItemsWithTuning } from "../core/scoring.js";
import { createEmptyMetrics, createItemId, normalizeWhitespace, titleFingerprint } from "../core/utils.js";
import type { ItemCategory, NormalizedItem, RankedItem, ReportState, ReviewInstruction, SourceConfig } from "../core/types.js";
import { buildLlmClassifyScore } from "../llm/classify-score.js";
import { buildLlmSummary, canReuseLlmSummary, type LlmSummaryAuditEvent } from "../llm/summary.js";
import { buildReportMarkdown } from "../report/markdown.js";
import { executeFeedbackRevision } from "../review/feedback-executor.js";
import { createReviewInstructionStore } from "../review/instruction-store.js";
import { collectMockItems } from "../sources/mock-source.js";
import { collectRssItems } from "../sources/rss-source.js";
import { SqliteEngine } from "../storage/sqlite-engine.js";
import { computeWeeklyReviewDeadline } from "../utils/time.js";
import { decideReviewAndPublish, resolvePendingStage } from "./review-policy.js";

export async function collectItemsNode(state: ReportState): Promise<Partial<ReportState>> {
  if (state.useMock) {
    // mock 模式用于学习与回归，保证在无网络或源不稳定时也能完整演练流程。
    const rawItems = collectMockItems(state.mode, state.generatedAt);
    const metrics = { ...state.metrics, collectedCount: rawItems.length };
    return { rawItems, metrics };
  }

  const runtimeConfigStore = createRuntimeConfigStore({
    backend: state.storageBackend,
    dbPath: state.storageDbPath,
    filePath: state.runtimeConfigPath,
    fallbackToFile: state.storageFallbackToFile,
  });
  const runtimeConfig = (await runtimeConfigStore.getCurrent()).config;
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

export async function llmClassifyScoreNode(state: ReportState): Promise<Partial<ReportState>> {
  // 先计算规则分类作为 baseline；即使 LLM 不可用，也能保证 rank 阶段有稳定输入。
  const ruleClassifiedItems = state.items.map((item) => ({
    ...item,
    category: resolveCategory(`${item.title} ${item.contentSnippet}`),
  }));

  const result = await buildLlmClassifyScore({
    items: ruleClassifiedItems,
    settings: {
      enabled: state.llmClassifyScoreEnabled,
      provider: state.llmSummaryProvider,
      minimaxApiKey: state.llmSummaryMinimaxApiKey,
      minimaxModel: state.llmSummaryMinimaxModel,
      timeoutMs: state.llmClassifyScoreTimeoutMs,
      batchSize: state.llmClassifyScoreBatchSize,
      maxConcurrency: state.llmClassifyScoreMaxConcurrency,
      globalMaxConcurrency: state.llmGlobalMaxConcurrency,
      minConfidence: state.llmClassifyScoreMinConfidence,
      promptVersion: state.llmClassifyScorePromptVersion,
    },
  });

  return {
    items: result.items,
    llmClassifyScoreMeta: result.meta,
    warnings: [...state.warnings, ...result.warnings],
  };
}

export async function rankItemsNode(state: ReportState): Promise<Partial<ReportState>> {
  const runtimeConfigStore = createRuntimeConfigStore({
    backend: state.storageBackend,
    dbPath: state.storageDbPath,
    filePath: state.runtimeConfigPath,
    fallbackToFile: state.storageFallbackToFile,
  });
  const runtimeConfig = (await runtimeConfigStore.getCurrent()).config;
  const sources = applyRuntimeSourceOverrides(await loadSourceConfig(state.sourceConfigPath), runtimeConfig);
  const ranked = rankItemsWithTuning(state.items, sources, state.generatedAt, {
    sourceWeightMultiplier: runtimeConfig.rankingWeights.source,
    freshnessMultiplier: runtimeConfig.rankingWeights.freshness,
    keywordMultiplier: runtimeConfig.rankingWeights.keyword,
    topicKeywords: runtimeConfig.topics,
    searchTermKeywords: runtimeConfig.searchTerms,
  });
  const fusedRanked = applyLlmFusionBeforeRank({
    rankedItems: ranked,
    rankFusionWeight: state.llmRankFusionWeight,
    minConfidence: state.llmClassifyScoreMinConfidence,
  });
  // highlights 用于报告顶部“重点推荐”，和“全覆盖正文”区分展示层次。
  const highlights = pickHighlights(fusedRanked, state.mode);

  const metrics = {
    ...state.metrics,
    highImportanceCount: fusedRanked.filter((item) => item.importance === "high").length,
    mediumImportanceCount: fusedRanked.filter((item) => item.importance === "medium").length,
    lowImportanceCount: fusedRanked.filter((item) => item.importance === "low").length,
    categoryBreakdown: buildCategoryBreakdown(fusedRanked),
  };

  return { rankedItems: fusedRanked, highlights, metrics };
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

export async function llmSummarizeNode(state: ReportState): Promise<Partial<ReportState>> {
  // 若 rankedItems 未变化且已有有效 LLM 结果，复检直接复用，避免重复调用外部模型造成额外成本。
  if (
    canReuseLlmSummary({
      summaryInputHash: state.summaryInputHash,
      rankedItems: state.rankedItems,
      meta: state.llmSummaryMeta,
      itemSummaries: state.itemSummaries,
      quickDigest: state.quickDigest,
      categoryLeadSummaries: state.categoryLeadSummaries,
    })
  ) {
    return {};
  }

  const result = await buildLlmSummary({
    rankedItems: state.rankedItems,
    generatedAt: state.generatedAt,
    settings: {
      enabled: state.llmSummaryEnabled,
      provider: state.llmSummaryProvider,
      minimaxApiKey: state.llmSummaryMinimaxApiKey,
      minimaxModel: state.llmSummaryMinimaxModel,
      timeoutMs: state.llmSummaryTimeoutMs,
      maxItems: state.llmSummaryMaxItems,
      maxConcurrency: state.llmSummaryMaxConcurrency,
      globalMaxConcurrency: state.llmGlobalMaxConcurrency,
      promptVersion: state.llmSummaryPromptVersion,
    },
  });

  let auditWarning: string | undefined;
  try {
    await appendLlmSummaryAuditEvents({
      dbPath: state.storageDbPath,
      runId: state.runId,
      reportDate: state.reportDate,
      generatedAt: state.generatedAt,
      events: result.auditEvents,
    });
  } catch (error) {
    // LLM 审计写入失败不应阻断主流程，避免存储抖动拖垮审核/发布链路。
    auditWarning = `llm_summary_audit_failed:${error instanceof Error ? error.message : String(error)}`;
  }

  // 摘要节点不再承担评分职责：仅补充可读性信息（如英文标题翻译），不改写 score/排序。
  const mergedRankedItems = mergeTranslatedTitlesFromSummaries(state.rankedItems, result.itemSummaries);
  const mergedHighlights = pickHighlights(mergedRankedItems, state.mode);
  const mergedMetrics = {
    ...state.metrics,
    highImportanceCount: mergedRankedItems.filter((item) => item.importance === "high").length,
    mediumImportanceCount: mergedRankedItems.filter((item) => item.importance === "medium").length,
    lowImportanceCount: mergedRankedItems.filter((item) => item.importance === "low").length,
  };

  return {
    rankedItems: mergedRankedItems,
    highlights: mergedHighlights,
    metrics: mergedMetrics,
    itemSummaries: result.itemSummaries,
    quickDigest: result.quickDigest,
    leadSummary: result.leadSummary,
    categoryLeadSummaries: result.categoryLeadSummaries,
    summaryInputHash: result.summaryInputHash,
    llmSummaryMeta: result.meta,
    warnings: [...state.warnings, ...result.warnings, ...(auditWarning ? [auditWarning] : [])],
  };
}

function mergeTranslatedTitlesFromSummaries(
  rankedItems: RankedItem[],
  itemSummaries: ReportState["itemSummaries"],
): RankedItem[] {
  const translatedTitleMap = new Map(
    itemSummaries
      .map((summary) => [summary.itemId, normalizeOptionalText(summary.titleZh)] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  );

  if (translatedTitleMap.size === 0) {
    return rankedItems;
  }

  return rankedItems.map((item) => {
    const translatedTitle = translatedTitleMap.get(item.id);
    if (!translatedTitle || translatedTitle === item.title) {
      return item;
    }
    return {
      ...item,
      titleZh: translatedTitle,
    };
  });
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
      storageBackend: state.storageBackend,
      storageDbPath: state.storageDbPath,
      storageFallbackToFile: state.storageFallbackToFile,
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
    quickDigest: state.quickDigest,
    itemSummaries: state.itemSummaries,
    leadSummary: state.leadSummary,
    categoryLeadSummaries: state.categoryLeadSummaries,
    llmSummaryMeta: state.llmSummaryMeta,
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
      storageBackend: state.storageBackend,
      storageDbPath: state.storageDbPath,
      storageFallbackToFile: state.storageFallbackToFile,
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
  storageBackend?: ReportState["storageBackend"];
  storageDbPath?: string;
  storageFallbackToFile?: boolean;
  sourceLimit: number;
  llmSummaryEnabled?: boolean;
  llmClassifyScoreEnabled?: boolean;
  llmClassifyScoreBatchSize?: number;
  llmClassifyScoreTimeoutMs?: number;
  llmClassifyScoreMaxConcurrency?: number;
  llmClassifyScoreMinConfidence?: number;
  llmClassifyScorePromptVersion?: string;
  llmSummaryProvider?: ReportState["llmSummaryProvider"];
  llmSummaryMinimaxApiKey?: string;
  llmSummaryMinimaxModel?: string;
  llmSummaryTimeoutMs?: number;
  llmSummaryMaxItems?: number;
  llmSummaryMaxConcurrency?: number;
  llmGlobalMaxConcurrency?: number;
  llmRankFusionWeight?: number;
  llmAssistMinConfidence?: number;
  llmSummaryPromptVersion?: string;
  llmFallbackAlertEnabled?: boolean;
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
    storageBackend: params.storageBackend ?? "file",
    storageDbPath: params.storageDbPath ?? "outputs/db/app.sqlite",
    storageFallbackToFile: params.storageFallbackToFile ?? true,
    sourceLimit: params.sourceLimit,
    llmSummaryEnabled: params.llmSummaryEnabled ?? false,
    llmClassifyScoreEnabled: params.llmClassifyScoreEnabled ?? true,
    llmClassifyScoreBatchSize: params.llmClassifyScoreBatchSize ?? 10,
    llmClassifyScoreTimeoutMs: params.llmClassifyScoreTimeoutMs ?? 60_000,
    llmClassifyScoreMaxConcurrency: params.llmClassifyScoreMaxConcurrency ?? 2,
    llmClassifyScoreMinConfidence: params.llmClassifyScoreMinConfidence ?? 0.6,
    llmClassifyScorePromptVersion: params.llmClassifyScorePromptVersion ?? "m5.4-v1",
    llmSummaryProvider: params.llmSummaryProvider ?? "minimax",
    llmSummaryMinimaxApiKey: params.llmSummaryMinimaxApiKey,
    llmSummaryMinimaxModel: params.llmSummaryMinimaxModel ?? "MiniMax-M2.5",
    llmSummaryTimeoutMs: params.llmSummaryTimeoutMs ?? 12_000,
    llmSummaryMaxItems: params.llmSummaryMaxItems ?? 30,
    llmSummaryMaxConcurrency: params.llmSummaryMaxConcurrency ?? 2,
    llmGlobalMaxConcurrency: params.llmGlobalMaxConcurrency ?? 2,
    llmRankFusionWeight: params.llmRankFusionWeight ?? 0.65,
    llmAssistMinConfidence: params.llmAssistMinConfidence ?? 0.5,
    llmSummaryPromptVersion: params.llmSummaryPromptVersion ?? "m5.3-v1",
    llmFallbackAlertEnabled: params.llmFallbackAlertEnabled ?? true,
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
    itemSummaries: [],
    quickDigest: [],
    leadSummary: "",
    categoryLeadSummaries: [],
    summaryInputHash: "",
    llmSummaryMeta: {
      enabled: params.llmSummaryEnabled ?? false,
      provider: params.llmSummaryProvider ?? "minimax",
      model: params.llmSummaryMinimaxModel ?? "MiniMax-M2.5",
      promptVersion: params.llmSummaryPromptVersion ?? "m5.3-v1",
      inputCount: 0,
      summarizedCount: 0,
      fallbackTriggered: false,
      zhQualityStats: {
        nonZhDetectedCount: 0,
        zhRepairAttemptedCount: 0,
        zhRepairSucceededCount: 0,
        englishRetainedCount: 0,
      },
    },
    llmClassifyScoreMeta: {
      enabled: params.llmClassifyScoreEnabled ?? true,
      inputCount: 0,
      processedCount: 0,
      fallbackCount: 0,
      fallbackTriggered: false,
    },
    warnings: [],
  };
}

function applyLlmFusionBeforeRank(input: {
  rankedItems: RankedItem[];
  rankFusionWeight: number;
  minConfidence: number;
}): RankedItem[] {
  if (input.rankedItems.length === 0) {
    return [];
  }

  const ruleScores = input.rankedItems.map((item) => item.score);
  const minRuleScore = Math.min(...ruleScores);
  const maxRuleScore = Math.max(...ruleScores);
  const fusionWeight = clampNumber(input.rankFusionWeight, 0, 1);
  const minConfidence = clampNumber(input.minConfidence, 0, 1);

  const merged = input.rankedItems.map((item) => {
    const ruleScoreNormalized = normalizeRuleScore(item.score, minRuleScore, maxRuleScore);
    const llmScore = typeof item.llmScore === "number" ? clampNumber(item.llmScore, 0, 100) : undefined;
    const confidence = typeof item.confidence === "number" ? clampNumber(item.confidence, 0, 1) : undefined;
    const usedLlm = typeof llmScore === "number" && typeof confidence === "number" && confidence >= minConfidence;
    const finalScore = usedLlm
      ? Number(((1 - fusionWeight) * ruleScoreNormalized + fusionWeight * llmScore).toFixed(2))
      : Number(ruleScoreNormalized.toFixed(2));

    return {
      ...item,
      score: finalScore,
      importance: resolveImportanceByScore(finalScore),
      scoreBreakdown: {
        ruleScore: item.score,
        ruleScoreNormalized,
        llmScore,
        finalScore,
        fusionWeight,
        usedLlm,
      },
    } satisfies RankedItem;
  });

  return [...merged].sort((a, b) => b.score - a.score);
}

function normalizeRuleScore(ruleScore: number, minScore: number, maxScore: number): number {
  if (maxScore <= minScore) {
    return clampNumber(ruleScore, 0, 100);
  }
  const normalized = ((ruleScore - minScore) / (maxScore - minScore)) * 100;
  return clampNumber(normalized, 0, 100);
}

function resolveImportanceByScore(score: number): RankedItem["importance"] {
  if (score >= 85) return "high";
  if (score >= 65) return "medium";
  return "low";
}

function clampNumber(input: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, input));
}

function normalizeOptionalText(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  const trimmed = input.trim();
  return trimmed || undefined;
}

async function appendLlmSummaryAuditEvents(input: {
  dbPath: string;
  runId: string;
  reportDate: string;
  generatedAt: string;
  events: LlmSummaryAuditEvent[];
}) {
  if (input.events.length === 0) {
    return;
  }
  const store = new DbAuditStore(new SqliteEngine(input.dbPath));
  for (const event of input.events) {
    await store.append({
      eventType: event.eventType,
      entityType: "report_run",
      entityId: input.reportDate,
      payload: {
        runId: input.runId,
        reportDate: input.reportDate,
        generatedAt: input.generatedAt,
        ...event.payload,
      },
      source: "pipeline",
      createdAt: new Date().toISOString(),
    });
  }
}

export const __test__ = {
  applyLlmFusionBeforeRank,
  mergeTranslatedTitlesFromSummaries,
  resolvePendingStage,
};

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

export async function loadEnabledSources(input: {
  sourceConfigPath: string;
  runtimeConfigPath?: string;
  storageBackend?: "file" | "db";
  storageDbPath?: string;
  storageFallbackToFile?: boolean;
}): Promise<SourceConfig[]> {
  const runtimeConfigStore = createRuntimeConfigStore({
    backend: input.storageBackend ?? "file",
    dbPath: input.storageDbPath ?? "outputs/db/app.sqlite",
    filePath: input.runtimeConfigPath ?? "outputs/runtime-config/global.json",
    fallbackToFile: input.storageFallbackToFile ?? true,
  });
  const runtimeConfig = (await runtimeConfigStore.getCurrent()).config;
  const sources = applyRuntimeSourceOverrides(await loadSourceConfig(input.sourceConfigPath), runtimeConfig);
  return sources.filter((source) => source.enabled);
}

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
    const store = createReviewInstructionStore({
      backend: state.storageBackend,
      dbPath: state.storageDbPath,
      fileRoot: state.reviewInstructionRoot,
      fallbackToFile: state.storageFallbackToFile,
    });
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
        runId: state.runId,
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
      runId: state.runId,
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
