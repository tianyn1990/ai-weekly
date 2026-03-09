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

    expect(fetchMock).toHaveBeenCalledTimes(16);
    expect(result.meta.fallbackTriggered).toBe(false);
    expect(result.itemSummaries.length).toBe(14);
    expect(result.quickDigest.length).toBe(8);
    expect(result.quickDigest[0]?.evidenceItemIds.length).toBeGreaterThan(0);
  });

  it("未显式配置全局并发时应使用默认值 2", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      const userContent = payload.messages?.find((message) => message.role === "user")?.content?.[0]?.text ?? "{}";
      const parsed = JSON.parse(userContent) as { item?: { id?: string } };
      if (parsed.item?.id) {
        return {
          ok: true,
          json: async () => ({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  summary: `${parsed.item.id} 总结`,
                  recommendation: `${parsed.item.id} 推荐`,
                  evidenceItemIds: [parsed.item.id],
                  confidence: 0.9,
                  llmScore: 90,
                }),
              },
            ],
          }),
        } satisfies Partial<Response> as Response;
      }
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: JSON.stringify({ lead: "导语/导读测试文本" }) }],
        }),
      } satisfies Partial<Response> as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildLlmSummary({
      rankedItems: Array.from({ length: 8 }).map((_, index) => createItem(index + 1)),
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3000,
        maxItems: 8,
        maxConcurrency: 6,
        promptVersion: "m5.3-test",
      },
    });

    expect(result.meta.fallbackTriggered).toBe(false);
    expect(result.meta.effectiveConcurrency).toBe(2);
  });

  it("分类导读生成失败时应回退模板导读", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      const userContent = payload.messages?.find((message) => message.role === "user")?.content?.[0]?.text ?? "{}";
      const parsed = JSON.parse(userContent) as { item?: { id?: string }; task?: string };
      if (parsed.item?.id) {
        return {
          ok: true,
          json: async () => ({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  summary: `${parsed.item.id} 总结`,
                  recommendation: `${parsed.item.id} 推荐`,
                  evidenceItemIds: [parsed.item.id],
                  confidence: 0.8,
                  llmScore: 80,
                }),
              },
            ],
          }),
        } satisfies Partial<Response> as Response;
      }
      if (parsed.task?.includes("导读")) {
        return {
          ok: true,
          json: async () => ({
            content: [],
          }),
        } satisfies Partial<Response> as Response;
      }
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: JSON.stringify({ lead: "本期导语测试文本。" }) }],
        }),
      } satisfies Partial<Response> as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const rankedItems = Array.from({ length: 6 }).map((_, index) => ({
      ...createItem(index + 1),
      category: index % 2 === 0 ? "agent" : "tooling",
    })) as RankedItem[];

    const result = await buildLlmSummary({
      rankedItems,
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3000,
        maxItems: 6,
        maxConcurrency: 2,
        promptVersion: "m5.3-test",
      },
    });

    expect(result.meta.fallbackTriggered).toBe(false);
    expect(result.categoryLeadSummaries.length).toBeGreaterThanOrEqual(2);
    expect(result.categoryLeadSummaries.some((item) => item.fallbackTriggered)).toBe(true);
  });

  it("首轮应使用轻量 prompt，严格重试才注入 few-shots", async () => {
    const capturedUserPayload: Array<Record<string, unknown>> = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: Array<{ role: string; content?: Array<{ type?: string; text?: string }> }>;
        };
        const userContent = payload.messages?.find((message) => message.role === "user")?.content?.[0]?.text ?? "{}";
        capturedUserPayload.push(JSON.parse(userContent) as Record<string, unknown>);
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: "```json\n```" }],
          }),
        } satisfies Partial<Response> as Response;
      })
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
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

    const lightPrompt = capturedUserPayload.find((payload) => payload.strictRetry === false) ?? {};
    const strictPrompt = capturedUserPayload.find((payload) => payload.strictRetry === true) ?? {};
    const lightExamples = Array.isArray(lightPrompt.fewShotExamples) ? lightPrompt.fewShotExamples : [];
    const strictExamples = Array.isArray(strictPrompt.fewShotExamples) ? strictPrompt.fewShotExamples : [];
    const lightContract = lightPrompt.outputContract as { selfCheck?: unknown[]; requiredKeys?: unknown[] } | undefined;
    const strictContract = strictPrompt.outputContract as { selfCheck?: unknown[]; requiredKeys?: unknown[] } | undefined;

    expect(capturedUserPayload.length).toBeGreaterThanOrEqual(2);
    expect(lightExamples.length).toBe(0);
    expect(Array.isArray(lightContract?.requiredKeys)).toBe(true);
    expect(Array.isArray(lightContract?.selfCheck)).toBe(false);
    expect(strictExamples.length).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(strictContract?.selfCheck)).toBe(true);
    expect(strictContract?.requiredKeys).toEqual(["summary", "recommendation", "evidenceItemIds", "confidence", "llmScore"]);
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

  it("应兼容提取非 text 类型 block 的文本", () => {
    const text = __test__.extractModelText({
      content: [
        {
          type: "output_text",
          text: '{"summary":"A","recommendation":"B","evidenceItemIds":["item-1"]}',
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

  it("成功率高于 70% 时不应全局回退，仅失败条目回退规则摘要", async () => {
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

  it("失败条目少于 3 时即便成功率不足也不应触发全局回退", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      const userContent = payload.messages?.find((message) => message.role === "user")?.content?.[0]?.text ?? "{}";
      const parsed = JSON.parse(userContent) as { item?: { id?: string } };
      const id = parsed.item?.id ?? "unknown";
      const isBad = id === "item-5" || id === "item-6";
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
      rankedItems: Array.from({ length: 6 }).map((_, index) => createItem(index + 1)),
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3000,
        maxItems: 6,
        maxConcurrency: 2,
        promptVersion: "m5.2-test",
      },
    });

    expect(result.meta.fallbackTriggered).toBe(false);
    expect(result.meta.summarizedCount).toBe(4);
    expect(result.warnings.join("\n")).toContain("部分条目回退");
  });

  it("成功率低于 70% 时应触发全局回退", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      const userContent = payload.messages?.find((message) => message.role === "user")?.content?.[0]?.text ?? "{}";
      const parsed = JSON.parse(userContent) as { item?: { id?: string } };
      const id = parsed.item?.id ?? "unknown";
      const isBad = id === "item-7" || id === "item-8" || id === "item-9" || id === "item-10";
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
    expect(result.meta.summarizedCount).toBe(6);
  });

  it("应在 meta 中记录失败分类与重试统计", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [],
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
        promptVersion: "m5.2-test",
      },
    });

    expect(result.meta.fallbackTriggered).toBe(true);
    expect(result.meta.failureStats?.missingContent).toBe(4);
    expect(result.meta.retryStats?.retryableTriggeredCount).toBeGreaterThan(0);
    expect(result.meta.retryStats?.serialDegradeTriggered).toBe(true);
    expect(result.meta.retryStats?.serialRetriedItemCount).toBe(4);
    expect(result.warnings.join("\n")).toContain("LLM 失败分类");
    expect(result.warnings.join("\n")).toContain("LLM 重试统计");
  });

  it("missing_content 簇状失败时应触发自适应降载并优先重试失败条目", async () => {
    const callCountById = new Map<string, number>();
    const unstableIds = new Set(["item-1", "item-2", "item-3"]);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      const userContent = payload.messages?.find((message) => message.role === "user")?.content?.[0]?.text ?? "{}";
      const parsed = JSON.parse(userContent) as { item?: { id?: string } };
      const id = parsed.item?.id ?? "lead";
      const nextCount = (callCountById.get(id) ?? 0) + 1;
      callCountById.set(id, nextCount);

      if (id === "lead") {
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: JSON.stringify({ lead: "本期导语测试文本。" }) }],
          }),
        } satisfies Partial<Response> as Response;
      }

      if (unstableIds.has(id) && nextCount <= 3) {
        return {
          ok: true,
          json: async () => ({
            content: [],
          }),
        } satisfies Partial<Response> as Response;
      }

      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: `${id} 总结`,
                recommendation: `${id} 推荐`,
                evidenceItemIds: [id],
                confidence: 0.8,
                llmScore: 80,
              }),
            },
          ],
        }),
      } satisfies Partial<Response> as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildLlmSummary({
      rankedItems: Array.from({ length: 6 }).map((_, index) => createItem(index + 1)),
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3000,
        maxItems: 6,
        maxConcurrency: 3,
        promptVersion: "m5.2-test",
      },
    });

    expect(result.meta.fallbackTriggered).toBe(false);
    expect(result.meta.summarizedCount).toBe(6);
    expect((result.meta.adaptiveDegradeStats?.triggerCount ?? 0) > 0).toBe(true);
    expect((result.meta.adaptiveDegradeStats?.degradedRetriedItemCount ?? 0) > 0).toBe(true);
    expect(result.warnings.join("\n")).toContain("窗口 missing_content 偏高");
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
      categoryLeadSummaries: [
        {
          category: "agent",
          lead: "Agent 方向本期建议优先关注工程落地与稳定性实践。",
          sourceItemIds: ["item-1"],
          fallbackTriggered: true,
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

  it("recommendation 允许描述性文本，不再要求固定动作词", () => {
    expect(() =>
      __test__.validateItemSummaryQuality({
        summary: "该实践提供了完整的 Agent 评测流程与工程步骤。",
        recommendation: "该方案提供了可参考的工程实现路径与实践细节。",
      }),
    ).not.toThrow();
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

  it("低于全局阈值时应先重试失败条目，重试后达标则不触发全局回退", async () => {
    const callCountById = new Map<string, number>();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      const userContent = payload.messages?.find((message) => message.role === "user")?.content?.[0]?.text ?? "{}";
      const parsed = JSON.parse(userContent) as { item?: { id?: string } };
      const id = parsed.item?.id ?? "unknown";

      const nextCount = (callCountById.get(id) ?? 0) + 1;
      callCountById.set(id, nextCount);
      const shouldFailInitially = id === "item-7" || id === "item-8" || id === "item-9" || id === "item-10";
      const keepFail = id === "item-10";
      const failNow = shouldFailInitially && (nextCount <= 2 || keepFail);

      const summary = failNow ? "summary" : `${id} 总结文本`;
      const recommendation = failNow ? "summary" : "建议工程团队优先评估接入成本与收益。";
      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary,
                recommendation,
                evidenceItemIds: [id],
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

    // 四个失败条目在首轮各重试一次（2 次），且在全局回退前再补偿 1 次。
    expect(callCountById.get("item-7")).toBe(3);
    expect(callCountById.get("item-8")).toBe(3);
    expect(callCountById.get("item-9")).toBe(3);
    expect(callCountById.get("item-10")).toBe(3);
    expect(result.meta.fallbackTriggered).toBe(false);
    expect(result.meta.summarizedCount).toBe(9);
    expect(result.warnings.join("\n")).toContain("部分条目回退");
  });

  it("missing_content 应触发额外重试一次", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "该更新补齐了工程观测链路。",
                recommendation: "建议工程团队优先评估接入成本与收益。",
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

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.meta.fallbackTriggered).toBe(false);
    expect(result.itemSummaries[0]?.summary).toContain("工程观测链路");
  });

  it("应对并发执行应用全局并发上限", async () => {
    let active = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      const userContent = payload.messages?.find((message) => message.role === "user")?.content?.[0]?.text ?? "{}";
      const parsed = JSON.parse(userContent) as { item?: { id?: string } };
      const id = parsed.item?.id ?? "lead";
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      if (id === "lead") {
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: JSON.stringify({ lead: "本期导语测试文本。" }) }],
          }),
        } satisfies Partial<Response> as Response;
      }
      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: `${id} 总结`,
                recommendation: `${id} 推荐`,
                evidenceItemIds: [id],
                confidence: 0.8,
                llmScore: 80,
              }),
            },
          ],
        }),
      } satisfies Partial<Response> as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await buildLlmSummary({
      rankedItems: Array.from({ length: 6 }).map((_, index) => createItem(index + 1)),
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3000,
        maxItems: 6,
        maxConcurrency: 6,
        globalMaxConcurrency: 2,
        promptVersion: "m5.2-test",
      },
    });

    expect(peak).toBeLessThanOrEqual(2);
  });

  it("应按规则分与 LLM 分融合重排", async () => {
    const items = [createItem(1), createItem(2)];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      const userContent = payload.messages?.find((message) => message.role === "user")?.content?.[0]?.text ?? "{}";
      const parsed = JSON.parse(userContent) as { item?: { id?: string } };
      const id = parsed.item?.id;
      if (!id) {
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: JSON.stringify({ lead: "本期导语测试文本。" }) }],
          }),
        } satisfies Partial<Response> as Response;
      }
      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: `${id} 总结`,
                recommendation: `${id} 推荐`,
                evidenceItemIds: [id],
                confidence: 0.9,
                llmScore: id === "item-1" ? 40 : 95,
              }),
            },
          ],
        }),
      } satisfies Partial<Response> as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildLlmSummary({
      rankedItems: items,
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3000,
        maxItems: 2,
        maxConcurrency: 2,
        rankFusionWeight: 1,
        assistMinConfidence: 0.5,
        promptVersion: "m5.2-test",
      },
    });

    expect(result.rankedItems[0]?.id).toBe("item-2");
    expect(result.rankedItems[0]?.scoreBreakdown?.usedLlm).toBe(true);
  });

  it("英文标题翻译成功时应写入 titleZh", async () => {
    const englishItem: RankedItem = {
      ...createItem(1),
      title: "LangGraph introduces multi-agent orchestration",
    };

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      const userContent = payload.messages?.find((message) => message.role === "user")?.content?.[0]?.text ?? "{}";
      const parsed = JSON.parse(userContent) as { item?: { id?: string } };
      const id = parsed.item?.id;
      if (!id) {
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: JSON.stringify({ lead: "本期导语测试文本。" }) }],
          }),
        } satisfies Partial<Response> as Response;
      }
      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "该指南聚焦多 Agent 编排落地。",
                recommendation: "建议工程团队优先评估编排策略与可观测能力。",
                evidenceItemIds: [id],
                confidence: 0.85,
                llmScore: 82,
                titleZh: "LangGraph 发布多 Agent 编排指南",
              }),
            },
          ],
        }),
      } satisfies Partial<Response> as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildLlmSummary({
      rankedItems: [englishItem, createItem(2)],
      generatedAt: "2026-03-08T00:00:00.000Z",
      settings: {
        enabled: true,
        provider: "minimax",
        minimaxApiKey: "test-key",
        minimaxModel: "MiniMax-M2.5",
        timeoutMs: 3000,
        maxItems: 2,
        maxConcurrency: 2,
        promptVersion: "m5.2-test",
      },
    });

    const translated = result.rankedItems.find((item) => item.id === "item-1");
    expect(translated?.titleZh).toContain("LangGraph 发布多 Agent 编排指南");
  });
});
