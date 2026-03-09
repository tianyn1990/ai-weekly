import { afterEach, describe, expect, it, vi } from "vitest";

import type { RankedItem } from "../src/core/types.js";
import { __test__, buildLlmSummary, canReuseLlmSummary } from "../src/llm/summary.js";

function createItem(index: number): RankedItem {
  return {
    id: `item-${index}`,
    sourceId: "source",
    sourceName: "source",
    title: `标题${index}`,
    link: `https://example.com/${index}`,
    contentSnippet: `这是第${index}条内容摘要，包含工程实践细节。`,
    publishedAt: "2026-03-08T00:00:00.000Z",
    category: "agent",
    score: 90 - index,
    importance: "high",
    recommendationReason: "测试推荐理由",
  };
}

describe("llm summary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("关闭 LLM 时应回退规则摘要", async () => {
    const result = await buildLlmSummary({
      rankedItems: [createItem(1), createItem(2), createItem(3), createItem(4), createItem(5)],
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: false,
        provider: "minimax",
        minimaxApiKey: undefined,
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 2000,
        maxItems: 10,
        maxConcurrency: 2,
        promptVersion: "m5.1-test",
      },
    });

    expect(result.meta.enabled).toBe(false);
    expect(result.meta.fallbackTriggered).toBe(true);
    expect(result.quickDigest.length).toBe(4);
    expect(result.warnings[0]).toContain("llm_summary_disabled");
  });

  it("缺少 MiniMax key 时应回退并记录原因", async () => {
    const result = await buildLlmSummary({
      rankedItems: [createItem(1), createItem(2), createItem(3), createItem(4)],
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 2000,
        maxItems: 10,
        maxConcurrency: 2,
        promptVersion: "m5.1-test",
      },
    });

    expect(result.meta.fallbackTriggered).toBe(true);
    expect(result.meta.fallbackReason).toContain("missing_minimax_api_key");
    expect(result.auditEvents.some((event) => event.eventType === "llm_summary_fallback")).toBe(true);
  });

  it("成功调用时应逐条总结并生成 4-12 条快速重点", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      const userContent = payload.messages?.find((message) => message.role === "user")?.content?.[0]?.text ?? "{}";
      const parsed = JSON.parse(userContent) as { item?: { id?: string } };
      const id = parsed.item?.id ?? "unknown";

      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: `${id} 的总结`,
                recommendation: `${id} 的推荐理由`,
                evidenceItemIds: [id],
              }),
            },
          ],
        }),
      } satisfies Partial<Response> as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await buildLlmSummary({
      rankedItems: Array.from({ length: 14 }).map((_, index) => createItem(index + 1)),
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3000,
        maxItems: 14,
        maxConcurrency: 3,
        promptVersion: "m5.1-test",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(14);
    expect(result.meta.fallbackTriggered).toBe(false);
    expect(result.itemSummaries.length).toBe(14);
    expect(result.quickDigest.length).toBe(8);
    expect(result.quickDigest[0]?.evidenceItemIds.length).toBeGreaterThan(0);
  });

  it("请求 prompt 应包含 few-shots 与输出自检约束", async () => {
    const capturedUserPayload: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      const userContent = payload.messages?.find((message) => message.role === "user")?.content?.[0]?.text ?? "{}";
      capturedUserPayload.push(JSON.parse(userContent) as Record<string, unknown>);
      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "测试总结",
                recommendation: "测试推荐",
                evidenceItemIds: ["item-1"],
              }),
            },
          ],
        }),
      } satisfies Partial<Response> as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await buildLlmSummary({
      rankedItems: [createItem(1)],
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3000,
        maxItems: 1,
        maxConcurrency: 1,
        promptVersion: "m5.1-test",
      },
    });

    const first = capturedUserPayload[0] ?? {};
    const examples = Array.isArray(first.fewShotExamples) ? first.fewShotExamples : [];
    const outputContract = first.outputContract as { selfCheck?: unknown[]; requiredKeys?: unknown[] } | undefined;
    expect(examples.length).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(outputContract?.selfCheck)).toBe(true);
    expect(Array.isArray(outputContract?.requiredKeys)).toBe(true);
    expect(outputContract?.requiredKeys).toEqual(["summary", "recommendation", "evidenceItemIds"]);
  });

  it("应兼容提取 OpenAI 风格 choices 返回文本", () => {
    const text = __test__.extractModelText({
      choices: [
        {
          message: {
            content: '{"summary":"A","recommendation":"B","evidenceItemIds":["item-1"]}',
          },
        },
      ],
    });
    expect(text).toContain('"summary":"A"');
  });

  it("证据不绑定导致成功率低于阈值时应全局回退", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              summary: "无效总结",
              recommendation: "无效推荐",
              evidenceItemIds: ["not-exist"],
            }),
          },
        ],
      }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildLlmSummary({
      rankedItems: [createItem(1), createItem(2), createItem(3), createItem(4)],
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3000,
        maxItems: 4,
        maxConcurrency: 2,
        promptVersion: "m5.1-test",
      },
    });

    expect(result.meta.fallbackTriggered).toBe(true);
    expect(result.meta.fallbackReason).toContain("llm_success_rate_below_threshold");
    expect(result.warnings.join("\n")).toContain("invalid_evidence_binding");
    expect(result.quickDigest.length).toBe(4);
  });

  it("首轮返回非 JSON 但可修复时应直接使用修复结果", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "这是一段普通说明文本，不是 JSON" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "重试后成功总结",
                recommendation: "重试后推荐理由",
                evidenceItemIds: ["item-1"],
              }),
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await buildLlmSummary({
      rankedItems: [createItem(1)],
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3000,
        maxItems: 1,
        maxConcurrency: 1,
        promptVersion: "m5.1-test",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.meta.fallbackTriggered).toBe(false);
    expect(result.itemSummaries[0]?.summary).toContain("普通说明文本");
  });

  it("首轮超时或 5xx 时应自动重试一次", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 504,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "重试后成功总结",
                recommendation: "重试后推荐理由",
                evidenceItemIds: ["item-1"],
              }),
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await buildLlmSummary({
      rankedItems: [createItem(1)],
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3000,
        maxItems: 1,
        maxConcurrency: 1,
        promptVersion: "m5.1-test",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.meta.fallbackTriggered).toBe(false);
    expect(result.itemSummaries[0]?.summary).toContain("重试后成功总结");
  });

  it("成功率等于 90% 时不应全局回退，仅失败条目回退规则摘要", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      const userContent = payload.messages?.find((message) => message.role === "user")?.content?.[0]?.text ?? "{}";
      const parsed = JSON.parse(userContent) as { item?: { id?: string } };
      const id = parsed.item?.id ?? "unknown";
      const isBad = id === "item-10";
      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: `${id} 总结`,
                recommendation: `${id} 推荐`,
                evidenceItemIds: isBad ? ["not-exist"] : [id],
              }),
            },
          ],
        }),
      } satisfies Partial<Response> as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildLlmSummary({
      rankedItems: Array.from({ length: 10 }).map((_, index) => createItem(index + 1)),
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3000,
        maxItems: 10,
        maxConcurrency: 3,
        promptVersion: "m5.1-test",
      },
    });

    expect(result.meta.fallbackTriggered).toBe(false);
    expect(result.meta.summarizedCount).toBe(9);
    expect(result.warnings.join("\n")).toContain("部分条目回退");
    expect(result.quickDigest.length).toBe(6);
  });

  it("成功率低于 90% 时应触发全局回退", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      const userContent = payload.messages?.find((message) => message.role === "user")?.content?.[0]?.text ?? "{}";
      const parsed = JSON.parse(userContent) as { item?: { id?: string } };
      const id = parsed.item?.id ?? "unknown";
      const isBad = id === "item-9" || id === "item-10";
      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: `${id} 总结`,
                recommendation: `${id} 推荐`,
                evidenceItemIds: isBad ? ["not-exist"] : [id],
              }),
            },
          ],
        }),
      } satisfies Partial<Response> as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildLlmSummary({
      rankedItems: Array.from({ length: 10 }).map((_, index) => createItem(index + 1)),
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3000,
        maxItems: 10,
        maxConcurrency: 3,
        promptVersion: "m5.1-test",
      },
    });

    expect(result.meta.fallbackTriggered).toBe(true);
    expect(result.meta.fallbackReason).toContain("llm_success_rate_below_threshold");
    expect(result.meta.summarizedCount).toBe(8);
  });

  it("可复用判断应基于 input hash 与 fallback 状态", () => {
    const items = [createItem(1), createItem(2), createItem(3), createItem(4)];
    const hash = __test__.computeSummaryInputHash(items);

    const reusable = canReuseLlmSummary({
      summaryInputHash: hash,
      rankedItems: items,
      meta: {
        enabled: true,
        provider: "minimax",
        inputCount: 4,
        summarizedCount: 4,
        fallbackTriggered: false,
      },
      itemSummaries: [
        {
          itemId: "item-1",
          title: "标题1",
          summary: "总结",
          recommendation: "推荐",
          evidenceItemIds: ["item-1"],
        },
      ],
      quickDigest: [
        {
          title: "标题1",
          takeaway: "总结",
          evidenceItemIds: ["item-1"],
        },
      ],
    });

    expect(reusable).toBe(true);
  });

  it("修复器应清理字段前缀和 code fence 噪音", () => {
    const repaired = __test__.repairSummaryFromText(
      '```json\n{"summary":"OpenAI 发布新一代推理模型并增强","recommendation":"\\"summary\\":\\"OpenAI 发布新一代推理模型并增强\\"","evidenceItemIds":["item-1"]}\n```',
      {
        id: "item-1",
        title: "OpenAI 发布新一代推理模型并增强",
        category: "industry-news",
        importance: "high",
      },
    );

    expect(repaired).not.toBeNull();
    expect(repaired?.summary).toBe("OpenAI 发布新一代推理模型并增强");
    expect(repaired?.summary.includes("summary")).toBe(false);
    expect(repaired?.recommendation).toContain("建议");
    expect(repaired?.recommendation.includes("summary")).toBe(false);
    expect(repaired?.evidenceItemIds).toContain("item-1");
  });

  it("质量闸门应拒绝占位词与摘要推荐重复", () => {
    expect(() =>
      __test__.validateItemSummaryQuality({
        summary: "summary",
        recommendation: "summary",
      }),
    ).toThrowError(/llm_quality_invalid/);
  });

  it("条目低质量时应触发重试并采用重试结果", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "summary",
                recommendation: "summary",
                evidenceItemIds: ["item-1"],
              }),
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "该教程补齐了 LangChain 长期记忆接入路径，强调工程化落地。",
                recommendation: "建议需要长期对话上下文的团队优先评估其可维护性与成本。",
                evidenceItemIds: ["item-1"],
              }),
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await buildLlmSummary({
      rankedItems: [createItem(1)],
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3000,
        maxItems: 1,
        maxConcurrency: 1,
        promptVersion: "m5.1-test",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.meta.fallbackTriggered).toBe(false);
    expect(result.itemSummaries[0]?.summary).not.toBe("summary");
    expect(result.itemSummaries[0]?.recommendation).not.toBe("summary");
  });

  it("截断句应触发首轮重试，但末轮仍截断时应保留而非回退", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "该分享来自 Anthropic 针对 Agent 的安全防护实践，",
                recommendation: "建议安全团队优先评估其防护清单与上线策略。",
                evidenceItemIds: ["item-1"],
              }),
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "该分享来自 Anthropic 针对 Agent 的安全防护实践，",
                recommendation: "建议安全团队优先评估其防护清单与上线策略。",
                evidenceItemIds: ["item-1"],
              }),
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await buildLlmSummary({
      rankedItems: [createItem(1)],
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3000,
        maxItems: 1,
        maxConcurrency: 1,
        promptVersion: "m5.1-test",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.meta.fallbackTriggered).toBe(false);
    expect(result.itemSummaries[0]?.summary.endsWith("，")).toBe(true);
    expect(result.warnings.length).toBe(0);
  });
});
