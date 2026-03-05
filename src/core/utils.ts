import crypto from "node:crypto";

import type { ItemCategory, PipelineMetrics } from "./types.js";

const EMPTY_CATEGORY_BREAKDOWN: Record<ItemCategory, number> = {
  "open-source": 0,
  tooling: 0,
  agent: 0,
  research: 0,
  "industry-news": 0,
  tutorial: 0,
  other: 0,
};

export function createItemId(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 12);
}

export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function createEmptyMetrics(): PipelineMetrics {
  return {
    collectedCount: 0,
    normalizedCount: 0,
    dedupedCount: 0,
    highImportanceCount: 0,
    mediumImportanceCount: 0,
    lowImportanceCount: 0,
    categoryBreakdown: { ...EMPTY_CATEGORY_BREAKDOWN },
  };
}

export function titleFingerprint(title: string): string {
  return normalizeWhitespace(title).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "");
}
