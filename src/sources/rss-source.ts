import Parser from "rss-parser";

import type { RawItem, SourceConfig } from "../core/types.js";

const parser = new Parser();
const RSS_FETCH_TIMEOUT_MS = 20_000;

export async function collectRssItems(sources: SourceConfig[], perSourceLimit: number): Promise<{ items: RawItem[]; warnings: string[] }> {
  const items: RawItem[] = [];
  const warnings: string[] = [];

  for (const source of sources) {
    if (!source.enabled || source.type !== "rss") {
      continue;
    }

    try {
      const xml = await fetchWithTimeout(source.url, RSS_FETCH_TIMEOUT_MS);
      const feed = await safeParseRss(xml);
      for (const entry of feed.items.slice(0, perSourceLimit)) {
        const link = entry.link ?? "";
        if (!link) {
          continue;
        }

        items.push({
          sourceId: source.id,
          sourceName: source.name,
          title: entry.title ?? "(无标题)",
          link,
          contentSnippet: entry.contentSnippet ?? entry.content ?? "",
          publishedAt: entry.isoDate ?? entry.pubDate,
        });
      }
    } catch (error) {
      warnings.push(`[${source.name}] 抓取失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { items, warnings };
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "ai-weekly-bot/0.1 (+https://example.com)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function safeParseRss(xml: string) {
  try {
    return await parser.parseString(xml);
  } catch {
    // 某些来源会返回未转义的 &，这里做一次容错清洗再解析。
    const sanitizedXml = xml.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\\d+;|#x[0-9a-fA-F]+;)/g, "&amp;");
    return await parser.parseString(sanitizedXml);
  }
}
