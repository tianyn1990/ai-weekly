import { describe, expect, it } from "vitest";

import { normalizeFeedbackPayload } from "../src/review/feedback-schema.js";

describe("feedback-schema", () => {
  it("应支持 snake_case 与 map 结构归一化", () => {
    const payload = normalizeFeedbackPayload({
      candidate_additions: [{ title: "新增条目", link: "https://example.com/a" }],
      source_toggles_map: { "openai-news": false },
      source_weights: { "langchain-blog": 92 },
      ranking_weights: { keyword: 1.1, freshness: 0.9 },
      new_topics: ["Agent"],
    });

    expect(payload?.candidateAdditions?.[0]?.title).toBe("新增条目");
    expect(payload?.sourceToggles?.[0]).toEqual({ sourceId: "openai-news", enabled: false });
    expect(payload?.sourceWeightAdjustments?.[0]).toEqual({ sourceId: "langchain-blog", weight: 92 });
    expect(payload?.rankingWeightAdjustments).toEqual(
      expect.arrayContaining([
        { dimension: "keyword", weight: 1.1 },
        { dimension: "freshness", weight: 0.9 },
      ]),
    );
    expect(payload?.newTopics).toEqual(["Agent"]);
  });

  it("无有效字段时应返回 undefined", () => {
    expect(normalizeFeedbackPayload({ action: "approve_final" })).toBeUndefined();
  });

  it("应支持自由文本修订字段归一化", () => {
    const payload = normalizeFeedbackPayload({
      revision_request: "请补充两条开源工具资讯，并删除重复条目",
      revision_scope: "all",
      revision_intent: "content_update",
      continue_from_checkpoint: true,
    });

    expect(payload?.revisionRequest).toBe("请补充两条开源工具资讯，并删除重复条目");
    expect(payload?.revisionScope).toBe("all");
    expect(payload?.revisionIntent).toBe("content_update");
    expect(payload?.continueFromCheckpoint).toBe(true);
  });
});
