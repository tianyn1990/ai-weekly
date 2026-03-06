import { describe, expect, it } from "vitest";

import {
  applyRuntimeSourceOverrides,
  createDefaultRuntimeConfig,
  mergeRuntimeConfigByFeedback,
} from "../src/config/runtime-config.js";

describe("runtime-config", () => {
  it("应将反馈指令合并到全局配置", () => {
    const current = createDefaultRuntimeConfig("2026-03-12T09:00:00.000Z");
    const merged = mergeRuntimeConfigByFeedback({
      current,
      nowIso: "2026-03-12T09:30:00.000Z",
      feedback: {
        newTopics: ["Agent Workflow"],
        newSearchTerms: ["LangGraph"],
        sourceToggles: [{ sourceId: "openai-news", enabled: false }],
        sourceWeightAdjustments: [{ sourceId: "langchain-blog", weight: 93 }],
        rankingWeightAdjustments: [{ dimension: "keyword", weight: 1.2 }],
      },
    });

    expect(merged.config.topics).toContain("Agent Workflow");
    expect(merged.config.searchTerms).toContain("LangGraph");
    expect(merged.config.sourceToggles["openai-news"]).toBe(false);
    expect(merged.config.sourceWeights["langchain-blog"]).toBe(93);
    expect(merged.config.rankingWeights.keyword).toBe(1.2);
    expect(merged.changedKeys).toEqual(
      expect.arrayContaining(["topics", "searchTerms", "sourceToggles", "sourceWeights", "rankingWeights"]),
    );
  });

  it("应将 runtime 覆盖应用到来源配置", () => {
    const runtime = createDefaultRuntimeConfig();
    runtime.sourceToggles["a"] = false;
    runtime.sourceWeights["b"] = 99;

    const sources = applyRuntimeSourceOverrides(
      [
        { id: "a", name: "A", type: "rss", url: "https://a.com/rss", language: "en", weight: 70, enabled: true },
        { id: "b", name: "B", type: "rss", url: "https://b.com/rss", language: "en", weight: 60, enabled: true },
      ],
      runtime,
    );

    expect(sources[0]?.enabled).toBe(false);
    expect(sources[1]?.weight).toBe(99);
  });
});
