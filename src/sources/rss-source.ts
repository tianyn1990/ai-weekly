import Parser from "rss-parser";

import type { RawItem, SourceConfig } from "../core/types.js";

const parser = new Parser();
const RSS_FETCH_TIMEOUT_MS = 20_000;
const RSS_FETCH_RETRY_DELAYS_MS = [300, 700];

export async function collectRssItems(sources: SourceConfig[], perSourceLimit: number): Promise<{ items: RawItem[]; warnings: string[] }> {
  const items: RawItem[] = [];
  const warnings: string[] = [];

  for (const source of sources) {
    if (!source.enabled || source.type !== "rss") {
      continue;
    }

    try {
      const xml = await fetchWithRetry(source.url, RSS_FETCH_TIMEOUT_MS);
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
      // fail-soft：单一来源失败不终止全局，交给上层统一在报告中暴露 warning。
      warnings.push(`[${source.name}] 抓取失败: ${formatFetchError(error)}`);
    }
  }

  return { items, warnings };
}

async function fetchWithRetry(url: string, timeoutMs: number): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RSS_FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fetchWithTimeout(url, timeoutMs);
    } catch (error) {
      lastError = error;

      // 对确定不可恢复的 HTTP 错误（如 4xx）不做重试，减少无效等待。
      if (!isRetryableFetchError(error) || attempt >= RSS_FETCH_RETRY_DELAYS_MS.length) {
        throw error;
      }

      await delay(RSS_FETCH_RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("fetch_failed");
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
      const error = new Error(`HTTP ${response.status}`) as Error & { retryable?: boolean };
      error.retryable = isRetryableStatus(response.status);
      throw error;
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  if (error && typeof error === "object" && "retryable" in error) {
    return (error as { retryable?: boolean }).retryable !== false;
  }
  return true;
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const message = error.message || "unknown_error";
  const directCode = readErrorCode(error);
  const causeCode = readErrorCode(error.cause);
  const code = causeCode ?? directCode;
  if (!code) {
    return message;
  }
  // 追加底层网络错误码（如 ENOTFOUND/ECONNRESET/ETIMEDOUT），方便快速判断是 DNS 还是连接抖动。
  return `${message} (code=${code})`;
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  if (!("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !code.trim()) {
    return undefined;
  }
  return code.trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function safeParseRss(xml: string) {
  try {
    return await parser.parseString(xml);
  } catch {
    // 某些来源会返回未转义的 &，先做容错清洗，减少 parse error 对稳定性的影响。
    const sanitizedXml = xml.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\\d+;|#x[0-9a-fA-F]+;)/g, "&amp;");
    return await parser.parseString(sanitizedXml);
  }
}
