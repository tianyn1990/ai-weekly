import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SourceConfig } from "../src/core/types.js";
import { collectGithubSearchItems } from "../src/sources/github-source.js";

const SOURCE: SourceConfig = {
  id: "github-hot",
  name: "GitHub 热门",
  type: "github_search",
  query: "topic:ai stars:>500 archived:false",
  sort: "updated",
  order: "desc",
  perPage: 10,
  language: "mixed",
  weight: 85,
  enabled: true,
};

function createGithubResponse(input: {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
} = {}): Response {
  const status = input.status ?? 200;
  const body = input.body ?? {
    items: [
      {
        full_name: "langgenius/dify",
        html_url: "https://github.com/langgenius/dify",
        description: "Open-source LLM app platform",
        stargazers_count: 120000,
        language: "TypeScript",
        updated_at: "2026-03-10T08:00:00Z",
        pushed_at: "2026-03-10T08:20:00Z",
      },
    ],
  };

  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(input.headers ?? {}),
    },
  });
}

describe("github-source", () => {
  const originalGithubToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.GITHUB_TOKEN = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.GITHUB_TOKEN = originalGithubToken;
    vi.restoreAllMocks();
  });

  it("配置 token 时应带鉴权请求并成功采集", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createGithubResponse());

    const result = await collectGithubSearchItems([SOURCE], 6, {
      githubToken: "test-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://api.github.com/search/repositories");
    expect(url).toContain("per_page=6");
    expect(requestInit.headers).toMatchObject({
      Authorization: "Bearer test-token",
    });
    expect(result.warnings).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceId: "github-hot",
      title: "langgenius/dify",
      link: "https://github.com/langgenius/dify",
    });
    expect(result.items[0]?.contentSnippet).toContain("stars=120000");
  });

  it("未配置 token 时应给出限流风险提示，但仍允许采集", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createGithubResponse());

    const result = await collectGithubSearchItems([SOURCE], 6, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.items).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("未配置 GITHUB_TOKEN");
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((requestInit.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("可重试 HTTP 错误应重试后成功", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createGithubResponse({ status: 500 }))
      .mockResolvedValueOnce(createGithubResponse());

    const pending = collectGithubSearchItems([SOURCE], 6, {
      githubToken: "test-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
      retryDelaysMs: [10],
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("限流错误应输出 warning 且不做无效重试", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createGithubResponse({
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
        },
      }),
    );

    const result = await collectGithubSearchItems([SOURCE], 6, {
      githubToken: "test-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
      retryDelaysMs: [10, 20],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("response=rate_limit");
  });
});
