import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectItemsNode, createInitialState } from "../src/pipeline/nodes.js";

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>demo</title>
    <item>
      <title>RSS Item</title>
      <link>https://example.com/rss-item</link>
      <description>rss snippet</description>
      <pubDate>Mon, 09 Mar 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

describe("collectItemsNode mixed sources", () => {
  let tempDir = "";
  const originalGithubToken = process.env.GITHUB_TOKEN;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-collect-node-"));
    process.env.GITHUB_TOKEN = "";
  });

  afterEach(async () => {
    process.env.GITHUB_TOKEN = originalGithubToken;
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("应聚合 rss 与 github_search 采集结果", async () => {
    const sourceConfigPath = path.join(tempDir, "sources.yaml");
    const runtimeConfigPath = path.join(tempDir, "runtime-config.json");

    await fs.writeFile(
      sourceConfigPath,
      [
        "- id: rss-demo",
        "  name: RSS Demo",
        "  type: rss",
        "  url: https://example.com/feed.xml",
        "  language: en",
        "  weight: 80",
        "  enabled: true",
        "",
        "- id: github-demo",
        "  name: GitHub Demo",
        "  type: github_search",
        "  query: \"topic:ai stars:>500 archived:false\"",
        "  language: mixed",
        "  weight: 85",
        "  enabled: true",
        "",
      ].join("\n"),
      "utf-8",
    );

    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target.includes("example.com/feed.xml")) {
        return new Response(RSS_XML, {
          status: 200,
          headers: { "content-type": "application/xml" },
        });
      }

      if (target.startsWith("https://api.github.com/search/repositories")) {
        return new Response(
          JSON.stringify({
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
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`unexpected_url:${target}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = createInitialState({
      mode: "daily",
      timezone: "Asia/Shanghai",
      useMock: false,
      sourceConfigPath,
      runtimeConfigPath,
      sourceLimit: 6,
      generatedAt: "2026-03-10T01:00:00.000Z",
      reportDate: "2026-03-10",
      runId: "test-collect-mixed",
      approveOutline: false,
      approveFinal: false,
      reviewInstructionRoot: tempDir,
    });

    const result = await collectItemsNode(state);
    expect(result.rawItems).toHaveLength(2);
    expect(result.metrics?.collectedCount).toBe(2);
    expect(result.rawItems?.map((item) => item.sourceId).sort()).toEqual(["github-demo", "rss-demo"]);
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.some((warning) => warning.includes("未配置 GITHUB_TOKEN"))).toBe(true);
  });
});
