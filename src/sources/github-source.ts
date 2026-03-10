import type { GithubSearchSourceConfig, RawItem, SourceConfig } from "../core/types.js";

const GITHUB_SEARCH_API_URL = "https://api.github.com/search/repositories";
const GITHUB_FETCH_TIMEOUT_MS = 20_000;
const GITHUB_FETCH_RETRY_DELAYS_MS = [400, 900];
const GITHUB_DEFAULT_PER_PAGE = 10;

interface CollectGithubSearchItemsOptions {
  githubToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelaysMs?: number[];
}

interface GithubRepository {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  language?: string | null;
  pushed_at?: string;
  updated_at?: string;
}

type GithubCollectorError = Error & {
  retryable?: boolean;
  status?: number;
  responseCode?: string;
};

/**
 * GitHub Search 采集器：
 * - 通过结构化 API 拉取热门仓库，减少依赖第三方 RSS 镜像的不确定性；
 * - 维持 fail-soft 语义，单源失败只写 warning，不中断主流程。
 */
export async function collectGithubSearchItems(
  sources: SourceConfig[],
  perSourceLimit: number,
  options: CollectGithubSearchItemsOptions = {},
): Promise<{ items: RawItem[]; warnings: string[] }> {
  const githubSources = sources.filter(isEnabledGithubSearchSource);
  if (githubSources.length === 0) {
    return { items: [], warnings: [] };
  }

  const items: RawItem[] = [];
  const warnings: string[] = [];
  const token = normalizeOptionalToken(options.githubToken ?? process.env.GITHUB_TOKEN);
  if (!token) {
    warnings.push("[GitHub Search] 未配置 GITHUB_TOKEN，已使用匿名配额，可能触发较严格限流。");
  }

  for (const source of githubSources) {
    try {
      const repositories = await fetchGithubRepositories({
        source,
        perPage: resolvePerPage(source, perSourceLimit),
        githubToken: token,
        timeoutMs: options.timeoutMs ?? GITHUB_FETCH_TIMEOUT_MS,
        retryDelaysMs: options.retryDelaysMs ?? GITHUB_FETCH_RETRY_DELAYS_MS,
        fetchImpl: options.fetchImpl ?? fetch,
      });

      for (const repo of repositories) {
        const link = normalizeText(repo.html_url);
        const title = normalizeText(repo.full_name);
        if (!link || !title) {
          continue;
        }

        items.push({
          sourceId: source.id,
          sourceName: source.name,
          title,
          link,
          contentSnippet: buildRepositorySnippet(repo),
          publishedAt: normalizeText(repo.pushed_at) || normalizeText(repo.updated_at) || undefined,
        });
      }
    } catch (error) {
      warnings.push(`[${source.name}] 抓取失败: ${formatGithubError(error)}`);
    }
  }

  return { items, warnings };
}

async function fetchGithubRepositories(input: {
  source: GithubSearchSourceConfig;
  perPage: number;
  githubToken?: string;
  timeoutMs: number;
  retryDelaysMs: number[];
  fetchImpl: typeof fetch;
}): Promise<GithubRepository[]> {
  const query = new URLSearchParams({
    q: input.source.query,
    sort: input.source.sort ?? "updated",
    order: input.source.order ?? "desc",
    per_page: String(input.perPage),
  });
  const url = `${GITHUB_SEARCH_API_URL}?${query.toString()}`;

  const response = await fetchWithRetry({
    url,
    githubToken: input.githubToken,
    timeoutMs: input.timeoutMs,
    retryDelaysMs: input.retryDelaysMs,
    fetchImpl: input.fetchImpl,
  });
  const payload = await safeParseJson(response);
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { items?: unknown }).items)) {
    throw createCollectorError("invalid_github_response:missing_items", {
      retryable: true,
      responseCode: "missing_items",
    });
  }

  return (payload as { items: GithubRepository[] }).items;
}

async function fetchWithRetry(input: {
  url: string;
  githubToken?: string;
  timeoutMs: number;
  retryDelaysMs: number[];
  fetchImpl: typeof fetch;
}): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= input.retryDelaysMs.length; attempt += 1) {
    try {
      return await fetchWithTimeout(input);
    } catch (error) {
      lastError = error;
      if (!isRetryableGithubError(error) || attempt >= input.retryDelaysMs.length) {
        throw error;
      }
      await delay(input.retryDelaysMs[attempt] ?? 0);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("github_fetch_failed");
}

async function fetchWithTimeout(input: {
  url: string;
  githubToken?: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const headers: Record<string, string> = {
      "User-Agent": "ai-weekly-bot/0.1 (+https://example.com)",
      Accept: "application/vnd.github+json",
    };
    if (input.githubToken) {
      headers.Authorization = `Bearer ${input.githubToken}`;
    }

    const response = await input.fetchImpl(input.url, {
      signal: controller.signal,
      headers,
    });
    if (!response.ok) {
      throw createHttpError(response);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function createHttpError(response: Response): GithubCollectorError {
  const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
  const isRateLimited = response.status === 403 && rateLimitRemaining === "0";
  const retryableByStatus = response.status === 408 || response.status === 429 || response.status >= 500;
  const retryable = isRateLimited ? false : retryableByStatus;
  const responseCode = isRateLimited ? "rate_limit" : `http_${response.status}`;
  return createCollectorError(`HTTP ${response.status}`, {
    retryable,
    status: response.status,
    responseCode,
  });
}

function createCollectorError(
  message: string,
  extra: {
    retryable?: boolean;
    status?: number;
    responseCode?: string;
  } = {},
): GithubCollectorError {
  const error = new Error(message) as GithubCollectorError;
  if (extra.retryable !== undefined) {
    error.retryable = extra.retryable;
  }
  if (extra.status !== undefined) {
    error.status = extra.status;
  }
  if (extra.responseCode) {
    error.responseCode = extra.responseCode;
  }
  return error;
}

function isRetryableGithubError(error: unknown): boolean {
  if (error && typeof error === "object" && "retryable" in error) {
    return (error as GithubCollectorError).retryable !== false;
  }
  return true;
}

function buildRepositorySnippet(repo: GithubRepository): string {
  const description = normalizeText(repo.description) || "无描述";
  const stars = typeof repo.stargazers_count === "number" ? repo.stargazers_count : 0;
  const language = normalizeText(repo.language) || "unknown";
  const updatedAt = normalizeText(repo.updated_at) || "unknown";
  return `${description} | stars=${stars} | language=${language} | updatedAt=${updatedAt}`;
}

function formatGithubError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const collectorError = error as GithubCollectorError;
  const parts = [collectorError.message || "unknown_error"];
  if (collectorError.responseCode) {
    parts.push(`response=${collectorError.responseCode}`);
  }
  const directCode = readErrorCode(collectorError);
  const causeCode = readErrorCode(collectorError.cause);
  if (causeCode ?? directCode) {
    parts.push(`code=${causeCode ?? directCode}`);
  }
  return parts.join(" ");
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !code.trim()) {
    return undefined;
  }
  return code.trim();
}

async function safeParseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    throw createCollectorError("invalid_github_response:empty_body", {
      retryable: true,
      responseCode: "empty_body",
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw createCollectorError("invalid_github_response:invalid_json", {
      retryable: true,
      responseCode: "invalid_json",
    });
  }
}

function normalizeOptionalToken(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function resolvePerPage(source: GithubSearchSourceConfig, perSourceLimit: number): number {
  const sourcePerPage = source.perPage ?? GITHUB_DEFAULT_PER_PAGE;
  const safeLimit = Number.isFinite(perSourceLimit) ? Math.max(1, Math.floor(perSourceLimit)) : GITHUB_DEFAULT_PER_PAGE;
  return Math.max(1, Math.min(100, sourcePerPage, safeLimit));
}

function normalizeText(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }
  return input.trim();
}

function isEnabledGithubSearchSource(source: SourceConfig): source is GithubSearchSourceConfig {
  return source.enabled && source.type === "github_search";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

