import dayjs from "dayjs";

import type { ImportanceLevel, NormalizedItem, RankedItem, SourceConfig } from "./types.js";

const KEYWORD_BOOST: Array<{ pattern: RegExp; score: number; reason: string }> = [
  { pattern: /agent|workflow|langgraph|langchain/i, score: 15, reason: "Agent 工程实践相关" },
  { pattern: /open source|开源|github/i, score: 12, reason: "开源生态更新" },
  { pattern: /benchmark|evaluation|评测|性能/i, score: 10, reason: "评测与性能信息" },
  { pattern: /security|安全|privacy/i, score: 8, reason: "安全与合规关注" },
  { pattern: /release|发布|new model|新模型/i, score: 10, reason: "模型或产品发布" },
  { pattern: /tutorial|guide|教程/i, score: 6, reason: "可直接学习实践" },
];

export function rankItems(items: NormalizedItem[], sources: SourceConfig[], nowIso: string): RankedItem[] {
  return rankItemsWithTuning(items, sources, nowIso, {
    sourceWeightMultiplier: 1,
    freshnessMultiplier: 1,
    keywordMultiplier: 1,
    topicKeywords: [],
    searchTermKeywords: [],
  });
}

export interface RankingTuning {
  sourceWeightMultiplier: number;
  freshnessMultiplier: number;
  keywordMultiplier: number;
  topicKeywords: string[];
  searchTermKeywords: string[];
}

export function rankItemsWithTuning(items: NormalizedItem[], sources: SourceConfig[], nowIso: string, tuning: RankingTuning): RankedItem[] {
  const sourceWeightMap = new Map(sources.map((source) => [source.id, source.weight]));
  const now = dayjs(nowIso);

  const ranked = items.map((item) => {
    const titleAndSnippet = `${item.title} ${item.contentSnippet}`;
    // 综合分 = source 权重 + 时效性 + 关键词加权，先保证可解释再追求复杂模型。
    const baseScore = (sourceWeightMap.get(item.sourceId) ?? 50) * tuning.sourceWeightMultiplier;
    const freshnessScore = calcFreshnessScore(item.publishedAt, now) * tuning.freshnessMultiplier;

    let keywordScore = 0;
    const reasons: string[] = [];

    for (const rule of KEYWORD_BOOST) {
      if (rule.pattern.test(titleAndSnippet)) {
        keywordScore += rule.score * tuning.keywordMultiplier;
        reasons.push(rule.reason);
      }
    }

    const topicBoost = calcTopicAndSearchBoost(titleAndSnippet, tuning.topicKeywords, tuning.searchTermKeywords);
    keywordScore += topicBoost.score;
    if (topicBoost.reason) {
      reasons.push(topicBoost.reason);
    }

    const total = baseScore + freshnessScore + keywordScore;
    const importance = resolveImportance(total);

    return {
      ...item,
      score: total,
      importance,
      recommendationReason: reasons[0] ?? "综合价值较高",
    } satisfies RankedItem;
  });

  return ranked.sort((a, b) => b.score - a.score);
}

function calcTopicAndSearchBoost(text: string, topics: string[], terms: string[]): { score: number; reason?: string } {
  const lower = text.toLowerCase();
  let matched = 0;

  for (const keyword of [...topics, ...terms]) {
    const normalized = keyword.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (lower.includes(normalized)) {
      matched += 1;
    }
  }

  if (matched === 0) {
    return { score: 0 };
  }

  return {
    score: Math.min(18, matched * 6),
    reason: "命中审核回流关键词",
  };
}

function calcFreshnessScore(publishedAt: string, now: dayjs.Dayjs): number {
  const published = dayjs(publishedAt);
  if (!published.isValid()) {
    return 0;
  }

  const hours = Math.max(1, now.diff(published, "hour"));

  if (hours <= 12) return 20;
  if (hours <= 24) return 15;
  if (hours <= 72) return 10;
  if (hours <= 168) return 5;
  return 0;
}

function resolveImportance(score: number): ImportanceLevel {
  if (score >= 85) return "high";
  if (score >= 65) return "medium";
  return "low";
}
