import { afterEach, describe, expect, it, vi } from "vitest";

import type { NormalizedItem } from "../src/core/types.js";
import { __test__, buildLlmClassifyScore } from "../src/llm/classify-score.js";

function createItem(index: number): NormalizedItem {
  return {
    id: `item-${index}`,
    sourceId: "source",
    sourceName: "source",
    title: `标题${index}`,
    link: `https://example.com/${index}`,
    contentSnippet: `这是第${index}条内容摘要，包含工程实践信息。`,
    publishedAt: "2026-03-10T00:00:00.000Z",
    category: "other",
  };
}

function parseRuntimeItemIds(init?: RequestInit): string[] {
  const payload = JSON.parse(String(init?.body ?? "{}")) as {
    messages?: Array<{ role?: string; content?: Array<{ text?: string }> }>;
  };
  const runtimeMessage = [...(payload.messages ?? [])].reverse().find((message) => message.role === "user");
  const text = runtimeMessage?.content?.[0]?.text ?? "{}";
  const parsed = JSON.parse(text) as { items?: Array<{ itemId?: string }> };
  return (parsed.items ?? []).map((item) => item.itemId ?? "").filter(Boolean);
}

describe("llm classify score", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("批量成功时应回写分类、llmScore 与 titleZh", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const ids = parseRuntimeItemIds(init);
      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: ids.map((id, index) => ({
                  itemId: id,
                  category: index === 0 ? "agent" : "tooling",
                  confidence: 0.92,
                  llmScore: index === 0 ? 90 : 84,
                  reason: `${id} 分类打分依据`,
                  domainTag: "engineering",
                  intentTag: "guide",
                  titleZh: index === 0 ? "条目一（中文）" : "",
                })),
              }),
            },
          ],
        }),
      } satisfies Partial<Response> as Response;
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await buildLlmClassifyScore({
      items: [createItem(1), createItem(2)],
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3_000,
        batchSize: 10,
        maxConcurrency: 2,
        globalMaxConcurrency: 2,
        minConfidence: 0.6,
        promptVersion: "m5.4-test",
      },
    });

    expect(result.meta.fallbackTriggered).toBe(false);
    expect(result.meta.llmAppliedCount).toBe(2);
    expect(result.items[0]?.category).toBe("agent");
    expect(result.items[0]?.llmScore).toBe(90);
    expect(result.items[0]?.titleZh).toBe("条目一（中文）");
    expect(result.items[1]?.category).toBe("tooling");
  });

  it("titleZh 非中文时应忽略，避免错误覆盖原标题", async () => {
    const englishItem: NormalizedItem = {
      ...createItem(1),
      title: "LangGraph introduces multi-agent orchestration",
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const [id] = parseRuntimeItemIds(init);
      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: [
                  {
                    itemId: id,
                    category: "agent",
                    confidence: 0.92,
                    llmScore: 91,
                    reason: "ok",
                    titleZh: "LangGraph multi-agent guide",
                  },
                ],
              }),
            },
          ],
        }),
      } satisfies Partial<Response> as Response;
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await buildLlmClassifyScore({
      items: [englishItem],
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3_000,
        batchSize: 10,
        maxConcurrency: 1,
        minConfidence: 0.6,
        promptVersion: "m5.4-test",
      },
    });

    expect(result.items[0]?.titleZh).toBeUndefined();
  });

  it("批次首轮失败后重试成功时应记录 batchRetry", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      callCount += 1;
      const ids = parseRuntimeItemIds(init);
      if (callCount === 1) {
        return {
          ok: false,
          status: 503,
          text: async () => "temporary unavailable",
        } satisfies Partial<Response> as Response;
      }
      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: ids.map((id) => ({
                  itemId: id,
                  category: "agent",
                  confidence: 0.9,
                  llmScore: 88,
                  reason: `${id} retry success`,
                })),
              }),
            },
          ],
        }),
      } satisfies Partial<Response> as Response;
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await buildLlmClassifyScore({
      items: [createItem(1), createItem(2)],
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3_000,
        batchSize: 10,
        maxConcurrency: 1,
        minConfidence: 0.6,
        promptVersion: "m5.4-test",
      },
    });

    expect(result.meta.fallbackTriggered).toBe(false);
    expect(result.meta.retryStats?.batchRetryCount).toBe(1);
    expect(result.meta.retryStats?.splitRetryCount).toBe(0);
  });

  it("批次持续失败时应拆批并对单条回退", async () => {
    const attempts = new Map<string, number>();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const ids = parseRuntimeItemIds(init);
      const key = ids.join(",");
      attempts.set(key, (attempts.get(key) ?? 0) + 1);

      if (key === "item-1,item-2" || key === "item-2") {
        return {
          ok: false,
          status: 503,
          text: async () => "overloaded",
        } satisfies Partial<Response> as Response;
      }

      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: [
                  {
                    itemId: "item-1",
                    category: "agent",
                    confidence: 0.9,
                    llmScore: 91,
                    reason: "item-1 success",
                  },
                ],
              }),
            },
          ],
        }),
      } satisfies Partial<Response> as Response;
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await buildLlmClassifyScore({
      items: [createItem(1), createItem(2)],
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3_000,
        batchSize: 10,
        maxConcurrency: 1,
        minConfidence: 0.6,
        promptVersion: "m5.4-test",
      },
    });

    expect(result.meta.fallbackTriggered).toBe(true);
    expect(result.meta.fallbackCount).toBe(1);
    expect(result.meta.retryStats?.splitRetryCount).toBeGreaterThan(0);
    expect(result.items.find((item) => item.id === "item-1")?.llmScore).toBe(91);
    expect(result.items.find((item) => item.id === "item-2")?.llmScore).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes("LLM 分类打分部分回退：1/2"))).toBe(true);
  });

  it("置信度低于阈值时应回退规则分类并记录 low_confidence", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const [id] = parseRuntimeItemIds(init);
      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: [
                  {
                    itemId: id,
                    category: "agent",
                    confidence: 0.3,
                    llmScore: 76,
                    reason: "confidence too low",
                  },
                ],
              }),
            },
          ],
        }),
      } satisfies Partial<Response> as Response;
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await buildLlmClassifyScore({
      items: [{ ...createItem(1), category: "tooling" }],
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3_000,
        batchSize: 10,
        maxConcurrency: 1,
        minConfidence: 0.6,
        promptVersion: "m5.4-test",
      },
    });

    expect(result.meta.fallbackTriggered).toBe(true);
    expect(result.meta.failureStats?.lowConfidence).toBe(1);
    expect(result.items[0]?.category).toBe("tooling");
    expect(result.items[0]?.llmScore).toBe(76);
  });

  it("应兼容 markdown fenced json 与 escaped json", () => {
    const fenced = "```json\n{\"results\":[{\"itemId\":\"item-1\",\"category\":\"agent\",\"confidence\":0.9,\"llmScore\":90,\"reason\":\"ok\"}]}\n```";
    const escaped = '"{\\"results\\":[{\\"itemId\\":\\"item-1\\",\\"category\\":\\"agent\\",\\"confidence\\":0.9,\\"llmScore\\":90,\\"reason\\":\\"ok\\"}]}"';

    const parsedFromFenced = __test__.parseJsonFromModelText(fenced) as { results: Array<{ itemId: string }> };
    const parsedFromEscaped = __test__.parseJsonFromModelText(escaped) as { results: Array<{ itemId: string }> };

    expect(parsedFromFenced.results[0]?.itemId).toBe("item-1");
    expect(parsedFromEscaped.results[0]?.itemId).toBe("item-1");
  });
});
