import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { RankingWeightDimension, ReviewFeedbackPayload, SourceConfig } from "../core/types.js";

const rankingWeightsSchema = z.object({
  source: z.number().min(0).max(3),
  freshness: z.number().min(0).max(3),
  keyword: z.number().min(0).max(3),
});

const runtimeConfigSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  topics: z.array(z.string().min(1)),
  searchTerms: z.array(z.string().min(1)),
  sourceToggles: z.record(z.string().min(1), z.boolean()),
  sourceWeights: z.record(z.string().min(1), z.number().min(1).max(100)),
  rankingWeights: rankingWeightsSchema,
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export interface RuntimeConfigMergeResult {
  config: RuntimeConfig;
  changedKeys: string[];
}

export function createDefaultRuntimeConfig(nowIso = new Date().toISOString()): RuntimeConfig {
  return {
    version: 1,
    updatedAt: nowIso,
    topics: [],
    searchTerms: [],
    sourceToggles: {},
    sourceWeights: {},
    rankingWeights: {
      source: 1,
      freshness: 1,
      keyword: 1,
    },
  };
}

export async function loadRuntimeConfig(configPath: string): Promise<RuntimeConfig> {
  try {
    const content = await fs.readFile(configPath, "utf-8");
    return runtimeConfigSchema.parse(JSON.parse(content));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createDefaultRuntimeConfig();
    }
    throw error;
  }
}

export async function saveRuntimeConfig(configPath: string, config: RuntimeConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export function applyRuntimeSourceOverrides(sources: SourceConfig[], config: RuntimeConfig): SourceConfig[] {
  return sources.map((source) => {
    const enabled = config.sourceToggles[source.id] ?? source.enabled;
    const adjustedWeight = config.sourceWeights[source.id] ?? source.weight;
    return {
      ...source,
      enabled,
      weight: adjustedWeight,
    };
  });
}

export function mergeRuntimeConfigByFeedback(input: {
  current: RuntimeConfig;
  feedback: ReviewFeedbackPayload;
  nowIso: string;
}): RuntimeConfigMergeResult {
  const { current, feedback, nowIso } = input;
  const next: RuntimeConfig = JSON.parse(JSON.stringify(current)) as RuntimeConfig;
  const changedKeys = new Set<string>();

  if (feedback.newTopics && feedback.newTopics.length > 0) {
    next.topics = mergeUniqueStrings(next.topics, feedback.newTopics);
    changedKeys.add("topics");
  }

  if (feedback.newSearchTerms && feedback.newSearchTerms.length > 0) {
    next.searchTerms = mergeUniqueStrings(next.searchTerms, feedback.newSearchTerms);
    changedKeys.add("searchTerms");
  }

  if (feedback.sourceToggles && feedback.sourceToggles.length > 0) {
    for (const entry of feedback.sourceToggles) {
      next.sourceToggles[entry.sourceId] = entry.enabled;
    }
    changedKeys.add("sourceToggles");
  }

  if (feedback.sourceWeightAdjustments && feedback.sourceWeightAdjustments.length > 0) {
    for (const entry of feedback.sourceWeightAdjustments) {
      next.sourceWeights[entry.sourceId] = entry.weight;
    }
    changedKeys.add("sourceWeights");
  }

  if (feedback.rankingWeightAdjustments && feedback.rankingWeightAdjustments.length > 0) {
    for (const entry of feedback.rankingWeightAdjustments) {
      setRankingWeight(next.rankingWeights, entry.dimension, entry.weight);
    }
    changedKeys.add("rankingWeights");
  }

  next.updatedAt = nowIso;
  return {
    config: runtimeConfigSchema.parse(next),
    changedKeys: Array.from(changedKeys.values()),
  };
}

function setRankingWeight(target: RuntimeConfig["rankingWeights"], dimension: RankingWeightDimension, weight: number) {
  if (dimension === "source") {
    target.source = weight;
    return;
  }
  if (dimension === "freshness") {
    target.freshness = weight;
    return;
  }
  target.keyword = weight;
}

function mergeUniqueStrings(base: string[], additions: string[]): string[] {
  const set = new Set(base.map((value) => value.trim()).filter((value) => value.length > 0));
  for (const value of additions) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    set.add(normalized);
  }
  return Array.from(set.values());
}
