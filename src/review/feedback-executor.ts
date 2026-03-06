import { loadSourceConfig } from "../config/source-config.js";
import {
  applyRuntimeSourceOverrides,
  loadRuntimeConfig,
  mergeRuntimeConfigByFeedback,
  saveRuntimeConfig,
} from "../config/runtime-config.js";
import { rankItemsWithTuning } from "../core/scoring.js";
import { createEmptyMetrics, createItemId, normalizeWhitespace } from "../core/utils.js";
import type { NormalizedItem, RankedItem, ReportMode, ReviewFeedbackPayload, ReviewInstruction, RevisionAuditLog } from "../core/types.js";

interface ExecuteFeedbackRevisionInput {
  mode: ReportMode;
  generatedAt: string;
  sourceConfigPath: string;
  runtimeConfigPath: string;
  rankedItems: RankedItem[];
  metrics: {
    collectedCount: number;
    normalizedCount: number;
    dedupedCount: number;
    highImportanceCount: number;
    mediumImportanceCount: number;
    lowImportanceCount: number;
    categoryBreakdown: Record<RankedItem["category"], number>;
  };
  instruction: ReviewInstruction;
}

interface ExecuteFeedbackRevisionResult {
  rankedItems: RankedItem[];
  highlights: RankedItem[];
  metrics: ExecuteFeedbackRevisionInput["metrics"];
  auditLog: RevisionAuditLog;
}

export async function executeFeedbackRevision(input: ExecuteFeedbackRevisionInput): Promise<ExecuteFeedbackRevisionResult> {
  const feedback = input.instruction.feedback;
  if (!feedback) {
    return {
      rankedItems: input.rankedItems,
      highlights: pickHighlights(input.rankedItems, input.mode),
      metrics: input.metrics,
      auditLog: {
        at: input.generatedAt,
        stage: input.instruction.stage,
        operator: input.instruction.operator,
        reason: input.instruction.reason,
        beforeCount: input.rankedItems.length,
        afterCount: input.rankedItems.length,
        addedCount: 0,
        removedCount: 0,
        globalConfigChanges: [],
        notes: "request_revision 未携带可执行反馈，跳过自动修订",
      },
    };
  }

  const beforeCount = input.rankedItems.length;
  const baseItems = input.rankedItems.map((item) => toNormalizedItem(item));
  const withRemovals = applyCandidateRemovals(baseItems, feedback);
  const withAdditions = applyCandidateAdditions(withRemovals.items, feedback, input.generatedAt);
  const filteredByToggle = applySourceToggleFilter(withAdditions.items, feedback);

  const runtimeConfigBefore = await loadRuntimeConfig(input.runtimeConfigPath);
  const runtimeMerge = mergeRuntimeConfigByFeedback({
    current: runtimeConfigBefore,
    feedback,
    nowIso: input.generatedAt,
  });
  await saveRuntimeConfig(input.runtimeConfigPath, runtimeMerge.config);

  const sourceConfig = await loadSourceConfig(input.sourceConfigPath);
  const effectiveSources = applyRuntimeSourceOverrides(sourceConfig, runtimeMerge.config);
  const rankedItems = rankItemsWithTuning(filteredByToggle, effectiveSources, input.generatedAt, {
    sourceWeightMultiplier: runtimeMerge.config.rankingWeights.source,
    freshnessMultiplier: runtimeMerge.config.rankingWeights.freshness,
    keywordMultiplier: runtimeMerge.config.rankingWeights.keyword,
    topicKeywords: runtimeMerge.config.topics,
    searchTermKeywords: runtimeMerge.config.searchTerms,
  });

  const metrics = rebuildMetrics(input.metrics, rankedItems);
  const afterCount = rankedItems.length;
  const removedCount = withRemovals.removedCount + withAdditions.filteredDuplicateCount;
  return {
    rankedItems,
    highlights: pickHighlights(rankedItems, input.mode),
    metrics,
    auditLog: {
      at: input.generatedAt,
      stage: input.instruction.stage,
      operator: input.instruction.operator,
      reason: input.instruction.reason,
      beforeCount,
      afterCount,
      addedCount: withAdditions.addedCount,
      removedCount,
      globalConfigChanges: runtimeMerge.changedKeys,
      notes: feedback.editorNotes,
    },
  };
}

function applyCandidateRemovals(items: NormalizedItem[], feedback: ReviewFeedbackPayload): { items: NormalizedItem[]; removedCount: number } {
  if (!feedback.candidateRemovals || feedback.candidateRemovals.length === 0) {
    return { items, removedCount: 0 };
  }

  const removeIds = new Set(feedback.candidateRemovals.map((item) => item.id).filter((value): value is string => Boolean(value)));
  const removeLinks = new Set(feedback.candidateRemovals.map((item) => item.link).filter((value): value is string => Boolean(value)));
  const filtered = items.filter((item) => !removeIds.has(item.id) && !removeLinks.has(item.link));
  return {
    items: filtered,
    removedCount: items.length - filtered.length,
  };
}

function applyCandidateAdditions(items: NormalizedItem[], feedback: ReviewFeedbackPayload, nowIso: string) {
  if (!feedback.candidateAdditions || feedback.candidateAdditions.length === 0) {
    return { items, addedCount: 0, filteredDuplicateCount: 0 };
  }

  const existingKey = new Set(items.map((item) => `${item.link}|${item.title.toLowerCase()}`));
  let filteredDuplicateCount = 0;
  const additions: NormalizedItem[] = [];
  for (const entry of feedback.candidateAdditions) {
    const title = normalizeWhitespace(entry.title);
    const link = normalizeWhitespace(entry.link ?? `https://manual.local/${createItemId(title)}`);
    const key = `${link}|${title.toLowerCase()}`;
    if (existingKey.has(key)) {
      filteredDuplicateCount += 1;
      continue;
    }
    existingKey.add(key);
    additions.push({
      id: createItemId(`manual-${link}-${title}`),
      sourceId: entry.sourceId ?? "manual-feedback",
      sourceName: entry.sourceName ?? "Manual Feedback",
      title,
      link,
      contentSnippet: normalizeWhitespace(entry.summary ?? "人工回流补充条目"),
      publishedAt: nowIso,
      category: entry.category ?? "other",
    });
  }

  return {
    items: [...items, ...additions],
    addedCount: additions.length,
    filteredDuplicateCount,
  };
}

function applySourceToggleFilter(items: NormalizedItem[], feedback: ReviewFeedbackPayload): NormalizedItem[] {
  if (!feedback.sourceToggles || feedback.sourceToggles.length === 0) {
    return items;
  }

  const disabledSourceIds = new Set(
    feedback.sourceToggles.filter((entry) => entry.enabled === false).map((entry) => entry.sourceId.trim()).filter(Boolean),
  );
  if (disabledSourceIds.size === 0) {
    return items;
  }
  return items.filter((item) => !disabledSourceIds.has(item.sourceId));
}

function toNormalizedItem(item: RankedItem): NormalizedItem {
  return {
    id: item.id,
    sourceId: item.sourceId,
    sourceName: item.sourceName,
    title: item.title,
    link: item.link,
    contentSnippet: item.contentSnippet,
    publishedAt: item.publishedAt,
    category: item.category,
  };
}

function rebuildMetrics(base: ExecuteFeedbackRevisionInput["metrics"], rankedItems: RankedItem[]) {
  const metrics = createEmptyMetrics();
  metrics.collectedCount = base.collectedCount;
  metrics.normalizedCount = rankedItems.length;
  metrics.dedupedCount = rankedItems.length;
  metrics.highImportanceCount = rankedItems.filter((item) => item.importance === "high").length;
  metrics.mediumImportanceCount = rankedItems.filter((item) => item.importance === "medium").length;
  metrics.lowImportanceCount = rankedItems.filter((item) => item.importance === "low").length;
  for (const item of rankedItems) {
    metrics.categoryBreakdown[item.category] += 1;
  }
  return metrics;
}

function pickHighlights(items: RankedItem[], mode: ReportMode): RankedItem[] {
  const limit = mode === "weekly" ? 8 : 5;
  return items.slice(0, limit);
}
