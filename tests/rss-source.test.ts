import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SourceConfig } from "../src/core/types.js";
import { collectRssItems } from "../src/sources/rss-source.js";

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>demo</title>
    <item>
      <title>LLM Weekly Update</title>
      <link>https://example.com/a</link>
      <description>demo snippet</description>
      <pubDate>Mon, 09 Mar 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const SOURCE: SourceConfig = {
  id: "test-rss",
  name: "Test RSS",
  type: "rss",
  url: "https://example.com/feed.xml",
  language: "en",
  weight: 80,
  enabled: true,
};

function createRssResponse(status = 200): Response {
  return new Response(RSS_XML, {
    status,
    headers: {
      "content-type": "application/xml",
    },
  });
}

describe("rss-source retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("遇到瞬时 fetch 失败应重试并成功采集", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(createRssResponse());
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const pending = collectRssItems([SOURCE], 5);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.warnings).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe("LLM Weekly Update");
  });

  it("HTTP 404 属于不可恢复错误时不应重试", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createRssResponse(404));
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const result = await collectRssItems([SOURCE], 5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("HTTP 404");
  });

  it("可重试错误在重试耗尽后应输出 warning", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const pending = collectRssItems([SOURCE], 5);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.items).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("fetch failed");
  });

  it("warning 应包含底层 cause code，便于区分网络错误类型", async () => {
    const networkError = new TypeError("fetch failed") as TypeError & { cause?: { code?: string } };
    networkError.cause = { code: "ENOTFOUND" };
    const fetchMock = vi.fn().mockRejectedValue(networkError);
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const pending = collectRssItems([SOURCE], 5);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("code=ENOTFOUND");
  });
});
