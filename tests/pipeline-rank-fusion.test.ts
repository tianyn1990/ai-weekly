import { describe, expect, it } from "vitest";

import type { RankedItem } from "../src/core/types.js";
import { __test__ } from "../src/pipeline/nodes.js";

function createRankedItem(input: {
  id: string;
  ruleScore: number;
  llmScore?: number;
  confidence?: number;
}): RankedItem {
  return {
    id: input.id,
    sourceId: "source",
    sourceName: "source",
    title: input.id,
    link: `https://example.com/${input.id}`,
    contentSnippet: "测试摘要",
    publishedAt: "2026-03-10T00:00:00.000Z",
    category: "agent",
    score: input.ruleScore,
    importance: "medium",
    recommendationReason: "测试推荐",
    llmScore: input.llmScore,
    confidence: input.confidence,
  };
}

describe("pipeline rank fusion", () => {
  it("应按融合分对全量条目重排", () => {
    const ranked = __test__.applyLlmFusionBeforeRank({
      rankedItems: [
        createRankedItem({ id: "item-1", ruleScore: 95, llmScore: 40, confidence: 0.95 }),
        createRankedItem({ id: "item-2", ruleScore: 80, llmScore: 100, confidence: 0.95 }),
      ],
      rankFusionWeight: 1,
      minConfidence: 0.6,
    });

    expect(ranked[0]?.id).toBe("item-2");
    expect(ranked[0]?.scoreBreakdown?.usedLlm).toBe(true);
    expect(ranked[1]?.scoreBreakdown?.usedLlm).toBe(true);
  });

  it("置信度不足时应回退规则分", () => {
    const ranked = __test__.applyLlmFusionBeforeRank({
      rankedItems: [
        createRankedItem({ id: "item-1", ruleScore: 95, llmScore: 90, confidence: 0.95 }),
        createRankedItem({ id: "item-2", ruleScore: 80, llmScore: 100, confidence: 0.4 }),
      ],
      rankFusionWeight: 0.65,
      minConfidence: 0.6,
    });

    const item2 = ranked.find((item) => item.id === "item-2");
    expect(item2?.scoreBreakdown?.usedLlm).toBe(false);
    expect(item2?.scoreBreakdown?.finalScore).toBe(0);
  });

  it("摘要翻译应仅回写 titleZh，不改写 score", () => {
    const rankedItems = [
      createRankedItem({ id: "item-1", ruleScore: 88, llmScore: 85, confidence: 0.9 }),
      createRankedItem({ id: "item-2", ruleScore: 70, llmScore: 60, confidence: 0.9 }),
    ];
    const merged = __test__.mergeTranslatedTitlesFromSummaries(rankedItems, [
      {
        itemId: "item-1",
        title: "item-1",
        titleZh: "条目一（中文）",
        summary: "测试摘要",
        recommendation: "测试推荐",
        evidenceItemIds: ["item-1"],
      },
    ]);

    expect(merged[0]?.titleZh).toBe("条目一（中文）");
    expect(merged[0]?.score).toBe(88);
    expect(merged[1]?.score).toBe(70);
  });
});
