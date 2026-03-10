import { z } from "zod";

import type {
  FeedbackCandidateAddition,
  FeedbackCandidateRemoval,
  FeedbackRankingWeightAdjustment,
  FeedbackSourceToggle,
  FeedbackSourceWeightAdjustment,
  ReviewFeedbackPayload,
} from "../core/types.js";

const itemCategorySchema = z.enum(["open-source", "tooling", "agent", "research", "industry-news", "tutorial", "other"]);

const candidateAdditionSchema: z.ZodType<FeedbackCandidateAddition> = z.object({
  title: z.string().min(1),
  link: z.string().url().optional(),
  summary: z.string().optional(),
  category: itemCategorySchema.optional(),
  sourceId: z.string().min(1).optional(),
  sourceName: z.string().min(1).optional(),
});

const candidateRemovalSchema: z.ZodType<FeedbackCandidateRemoval> = z
  .object({
    id: z.string().min(1).optional(),
    link: z.string().url().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.id && !value.link) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "candidateRemoval 至少需要 id 或 link",
      });
    }
  });

const sourceToggleSchema: z.ZodType<FeedbackSourceToggle> = z.object({
  sourceId: z.string().min(1),
  enabled: z.boolean(),
});

const sourceWeightAdjustmentSchema: z.ZodType<FeedbackSourceWeightAdjustment> = z.object({
  sourceId: z.string().min(1),
  weight: z.number().min(1).max(100),
});

const rankingWeightAdjustmentSchema: z.ZodType<FeedbackRankingWeightAdjustment> = z.object({
  dimension: z.enum(["source", "freshness", "keyword"]),
  weight: z.number().min(0).max(3),
});

const revisionScopeSchema = z.enum(["all", "category", "item"]);

const revisionIntentSchema = z.enum([
  "general_refine",
  "content_update",
  "structure_adjust",
  "add_information",
  "remove_information",
  "other",
]);

export const reviewFeedbackPayloadSchema: z.ZodType<ReviewFeedbackPayload> = z
  .object({
    // 自由文本修订入口：供 ReAct Planner 拆解多条任务。
    revisionRequest: z.string().min(1).optional(),
    revisionScope: revisionScopeSchema.optional(),
    revisionIntent: revisionIntentSchema.optional(),
    continueFromCheckpoint: z.boolean().optional(),
    candidateAdditions: z.array(candidateAdditionSchema).optional(),
    candidateRemovals: z.array(candidateRemovalSchema).optional(),
    newTopics: z.array(z.string().min(1)).optional(),
    newSearchTerms: z.array(z.string().min(1)).optional(),
    sourceToggles: z.array(sourceToggleSchema).optional(),
    sourceWeightAdjustments: z.array(sourceWeightAdjustmentSchema).optional(),
    rankingWeightAdjustments: z.array(rankingWeightAdjustmentSchema).optional(),
    editorNotes: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const hasDirective = Boolean(
      (value.candidateAdditions && value.candidateAdditions.length > 0) ||
        (value.candidateRemovals && value.candidateRemovals.length > 0) ||
        (value.newTopics && value.newTopics.length > 0) ||
        (value.newSearchTerms && value.newSearchTerms.length > 0) ||
        (value.sourceToggles && value.sourceToggles.length > 0) ||
        (value.sourceWeightAdjustments && value.sourceWeightAdjustments.length > 0) ||
        (value.rankingWeightAdjustments && value.rankingWeightAdjustments.length > 0) ||
        value.revisionRequest ||
        value.editorNotes,
    );
    if (!hasDirective) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "feedback 至少需要一个有效字段",
      });
    }
  });

// 支持 snake_case / map 结构输入，统一转为内部 camelCase 数组结构。
export function normalizeFeedbackPayload(input: unknown): ReviewFeedbackPayload | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const normalized: ReviewFeedbackPayload = {
    revisionRequest: readString(input, "revisionRequest") ?? readString(input, "revision_request"),
    revisionScope: (readString(input, "revisionScope") ?? readString(input, "revision_scope")) as
      | ReviewFeedbackPayload["revisionScope"]
      | undefined,
    revisionIntent: (readString(input, "revisionIntent") ?? readString(input, "revision_intent")) as
      | ReviewFeedbackPayload["revisionIntent"]
      | undefined,
    continueFromCheckpoint: readBoolean(input, "continueFromCheckpoint", "continue_from_checkpoint"),
    candidateAdditions: readArray(input, "candidateAdditions", "candidate_additions"),
    candidateRemovals: readArray(input, "candidateRemovals", "candidate_removals"),
    newTopics: readStringArray(input, "newTopics", "new_topics"),
    newSearchTerms: readStringArray(input, "newSearchTerms", "new_search_terms"),
    sourceToggles: normalizeSourceToggles(input),
    sourceWeightAdjustments: normalizeSourceWeightAdjustments(input),
    rankingWeightAdjustments: normalizeRankingWeightAdjustments(input),
    editorNotes: readString(input, "editorNotes") ?? readString(input, "editor_notes"),
  };

  const compacted = Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
  if (Object.keys(compacted).length === 0) {
    return undefined;
  }

  return reviewFeedbackPayloadSchema.parse(compacted);
}

function normalizeSourceToggles(input: Record<string, unknown>) {
  const direct = readArray(input, "sourceToggles", "source_toggles");
  if (direct) {
    return direct;
  }

  const map = input.source_toggles_map ?? input.sourceTogglesMap;
  if (!isRecord(map)) {
    return undefined;
  }
  return Object.entries(map).map(([sourceId, enabled]) => ({ sourceId, enabled: Boolean(enabled) }));
}

function normalizeSourceWeightAdjustments(input: Record<string, unknown>) {
  const direct = readArray(input, "sourceWeightAdjustments", "source_weight_adjustments");
  if (direct) {
    return direct;
  }

  const map = input.source_weights ?? input.sourceWeights;
  if (!isRecord(map)) {
    return undefined;
  }
  return Object.entries(map).map(([sourceId, weight]) => ({ sourceId, weight: Number(weight) }));
}

function normalizeRankingWeightAdjustments(input: Record<string, unknown>) {
  const direct = readArray(input, "rankingWeightAdjustments", "ranking_weight_adjustments");
  if (direct) {
    return direct;
  }

  const map = input.ranking_weights ?? input.rankingWeights;
  if (!isRecord(map)) {
    return undefined;
  }
  return Object.entries(map).map(([dimension, weight]) => ({ dimension, weight: Number(weight) }));
}

function readArray(input: Record<string, unknown>, camelKey: string, snakeKey: string) {
  const value = input[camelKey] ?? input[snakeKey];
  return Array.isArray(value) ? value : undefined;
}

function readStringArray(input: Record<string, unknown>, camelKey: string, snakeKey: string): string[] | undefined {
  const value = input[camelKey] ?? input[snakeKey];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => String(item)).filter((item) => item.length > 0);
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(input: Record<string, unknown>, camelKey: string, snakeKey: string): boolean | undefined {
  const value = input[camelKey] ?? input[snakeKey];
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}
