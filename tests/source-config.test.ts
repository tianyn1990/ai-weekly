import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadSourceConfig } from "../src/config/source-config.js";

describe("source-config", () => {
  it("应支持 mixed source 配置并为 github_search 注入默认字段", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-source-config-"));
    const filePath = path.join(tempDir, "sources.yaml");

    try {
      await fs.writeFile(
        filePath,
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

      const sources = await loadSourceConfig(filePath);
      expect(sources).toHaveLength(2);

      const rssSource = sources.find((source) => source.id === "rss-demo");
      expect(rssSource).toMatchObject({
        type: "rss",
        url: "https://example.com/feed.xml",
      });

      const githubSource = sources.find((source) => source.id === "github-demo");
      expect(githubSource).toMatchObject({
        type: "github_search",
        query: "topic:ai stars:>500 archived:false",
        sort: "updated",
        order: "desc",
        perPage: 10,
        queryMode: "dual",
        activeWindowDays: 7,
        newRepoWindowDays: 14,
        cooldownDays: 10,
        breakoutMinStars: 200000,
        breakoutRecentHours: 24,
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("github_search 缺少 query 时应校验失败", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-source-config-"));
    const filePath = path.join(tempDir, "invalid-sources.yaml");

    try {
      await fs.writeFile(
        filePath,
        [
          "- id: github-invalid",
          "  name: GitHub Invalid",
          "  type: github_search",
          "  language: mixed",
          "  weight: 80",
          "  enabled: true",
          "",
        ].join("\n"),
        "utf-8",
      );

      await expect(loadSourceConfig(filePath)).rejects.toThrow();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
