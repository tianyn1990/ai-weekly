import type {
  GithubCollectionQueryStat,
  GithubQueryMode,
  GithubSearchSourceConfig,
  GithubSelectionMeta,
  RawItem,
  SourceConfig,
} from "../core/types.js";

const GITHUB_SEARCH_API_URL = "https://api.github.com/search/repositories";
const GITHUB_FETCH_TIMEOUT_MS = 20_000;
const GITHUB_FETCH_RETRY_DELAYS_MS = [400, 900];
const GITHUB_DEFAULT_PER_PAGE = 10;
const GITHUB_DEFAULT_ACTIVE_WINDOW_DAYS = 7;
const GITHUB_DEFAULT_NEW_REPO_WINDOW_DAYS = 14;
const GITHUB_DEFAULT_COOLDOWN_DAYS = 10;
const GITHUB_DEFAULT_BREAKOUT_MIN_STARS = 200_000;
const GITHUB_DEFAULT_BREAKOUT_RECENT_HOURS = 24;

interface CollectGithubSearchItemsOptions {
  githubToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  nowIso?: string;
  historyByRepoLastSelectedAt?: Map<string, string> | Record<string, string>;
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

interface GithubSourceResolvedOptions {
  queryMode: GithubQueryMode;
  activeWindowDays: number;
  newRepoWindowDays: number;
  cooldownDays: number;
  breakoutMinStars: number;
  breakoutRecentHours: number;
}

interface GithubQueryPlan {
  queryPath: GithubCollectionQueryStat["queryPath"];
  query: string;
}

/**
 * GitHub Search 采集器：
 * - dual 查询并集（活跃窗口 + 新仓窗口）提升“热点 + 新鲜”覆盖；
 * - fail-soft：单路径失败只记 warning，不中断整条流水线；
 * - 冷却策略：降低同仓库跨天重复曝光，命中高强度动态时允许突破。
 */
export async function collectGithubSearchItems(
  sources: SourceConfig[],
  perSourceLimit: number,
  options: CollectGithubSearchItemsOptions = {},
): Promise<{ items: RawItem[]; warnings: string[]; meta?: GithubSelectionMeta }> {
  const githubSources = sources.filter(isEnabledGithubSearchSource);
  if (githubSources.length === 0) {
    return {
      items: [],
      warnings: [],
      meta: {
        sourceCount: 0,
        queryMode: "single",
        queryStats: [],
        collectedRepoCount: 0,
        mergedRepoCount: 0,
        historicalRepoCount: 0,
        cooldownDays: 0,
        cooldownSuppressedCount: 0,
        breakoutAllowedCount: 0,
        keptRepoCount: 0,
        selectedRepoCount: 0,
      },
    };
  }

  const warnings: string[] = [];
  const items: RawItem[] = [];
  const queryStats: GithubCollectionQueryStat[] = [];
  const historyMap = normalizeHistoryMap(options.historyByRepoLastSelectedAt);
  const now = resolveNowDate(options.nowIso);

  let collectedRepoCount = 0;
  let mergedRepoCount = 0;
  let cooldownSuppressedCount = 0;
  let breakoutAllowedCount = 0;
  let keptRepoCount = 0;
  let maxCooldownDays = 0;
  const queryModes = new Set<GithubQueryMode>();

  const token = normalizeOptionalToken(options.githubToken ?? process.env.GITHUB_TOKEN);
  if (!token) {
    warnings.push("[GitHub Search] 未配置 GITHUB_TOKEN，已使用匿名配额，可能触发较严格限流。");
  }

  for (const source of githubSources) {
    const resolved = resolveSourceOptions(source);
    queryModes.add(resolved.queryMode);
    maxCooldownDays = Math.max(maxCooldownDays, resolved.cooldownDays);

    const queryPlans = buildQueryPlans(source, resolved, now);
    const mergedByKey = new Map<string, GithubRepository>();

    for (const plan of queryPlans) {
      try {
        const repositories = await fetchGithubRepositories({
          query: plan.query,
          sort: source.sort,
          order: source.order,
          perPage: resolvePerPage(source, perSourceLimit),
          githubToken: token,
          timeoutMs: options.timeoutMs ?? GITHUB_FETCH_TIMEOUT_MS,
          retryDelaysMs: options.retryDelaysMs ?? GITHUB_FETCH_RETRY_DELAYS_MS,
          fetchImpl: options.fetchImpl ?? fetch,
        });

        queryStats.push({
          sourceId: source.id,
          sourceName: source.name,
          queryPath: plan.queryPath,
          query: plan.query,
          fetchedCount: repositories.length,
        });
        collectedRepoCount += repositories.length;

        for (const repo of repositories) {
          const key = resolveRepositoryKey(repo);
          if (!key || mergedByKey.has(key)) {
            continue;
          }
          mergedByKey.set(key, repo);
        }
      } catch (error) {
        const failedReason = formatGithubError(error);
        queryStats.push({
          sourceId: source.id,
          sourceName: source.name,
          queryPath: plan.queryPath,
          query: plan.query,
          fetchedCount: 0,
          failedReason,
        });
        warnings.push(`[${source.name}] 抓取失败(${plan.queryPath}): ${failedReason}`);
      }
    }

    const mergedRepositories = [...mergedByKey.values()];
    mergedRepoCount += mergedRepositories.length;

    for (const repo of mergedRepositories) {
      const link = normalizeText(repo.html_url);
      const title = normalizeText(repo.full_name);
      if (!link || !title) {
        continue;
      }

      const cooldownDecision = decideCooldownSuppression({
        repo,
        repoFullName: title,
        historyMap,
        now,
        cooldownDays: resolved.cooldownDays,
        breakoutMinStars: resolved.breakoutMinStars,
        breakoutRecentHours: resolved.breakoutRecentHours,
      });
      if (cooldownDecision.suppressed) {
        cooldownSuppressedCount += 1;
        continue;
      }
      if (cooldownDecision.breakoutAllowed) {
        breakoutAllowedCount += 1;
      }

      items.push({
        sourceId: source.id,
        sourceName: source.name,
        title,
        link,
        contentSnippet: buildRepositorySnippet(repo),
        publishedAt: normalizeText(repo.pushed_at) || normalizeText(repo.updated_at) || undefined,
      });
      keptRepoCount += 1;
    }
  }

  const queryMode: GithubSelectionMeta["queryMode"] =
    queryModes.size === 1 ? [...queryModes][0] ?? "single" : "mixed";

  return {
    items,
    warnings,
    meta: {
      sourceCount: githubSources.length,
      queryMode,
      queryStats,
      collectedRepoCount,
      mergedRepoCount,
      historicalRepoCount: historyMap.size,
      cooldownDays: maxCooldownDays,
      cooldownSuppressedCount,
      breakoutAllowedCount,
      keptRepoCount,
      selectedRepoCount: 0,
    },
  };
}

function resolveSourceOptions(source: GithubSearchSourceConfig): GithubSourceResolvedOptions {
  return {
    queryMode: source.queryMode ?? "dual",
    activeWindowDays: source.activeWindowDays ?? GITHUB_DEFAULT_ACTIVE_WINDOW_DAYS,
    newRepoWindowDays: source.newRepoWindowDays ?? GITHUB_DEFAULT_NEW_REPO_WINDOW_DAYS,
    cooldownDays: source.cooldownDays ?? GITHUB_DEFAULT_COOLDOWN_DAYS,
    breakoutMinStars: source.breakoutMinStars ?? GITHUB_DEFAULT_BREAKOUT_MIN_STARS,
    breakoutRecentHours: source.breakoutRecentHours ?? GITHUB_DEFAULT_BREAKOUT_RECENT_HOURS,
  };
}

function buildQueryPlans(
  source: GithubSearchSourceConfig,
  options: GithubSourceResolvedOptions,
  now: Date,
): GithubQueryPlan[] {
  const baseQuery = sanitizeQueryBase(source.query);
  if (options.queryMode === "single") {
    return [{ queryPath: "single", query: baseQuery }];
  }

  const activeDate = formatDateInUtcDaysAgo(now, options.activeWindowDays);
  const newRepoDate = formatDateInUtcDaysAgo(now, options.newRepoWindowDays);

  return [
    {
      queryPath: "active_window",
      query: `${baseQuery} pushed:>=${activeDate}`,
    },
    {
      queryPath: "new_repo_window",
      query: `${baseQuery} created:>=${newRepoDate}`,
    },
  ];
}

function sanitizeQueryBase(input: string): string {
  // 移除旧的 created/pushed 限定，避免与窗口策略叠加后产生冲突查询。
  return input
    .replace(/\b(?:created|pushed):[^\s]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDateInUtcDaysAgo(now: Date, days: number): string {
  const safeDays = Math.max(0, Math.floor(days));
  const timestamp = now.getTime() - safeDays * 24 * 60 * 60 * 1000;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function decideCooldownSuppression(input: {
  repo: GithubRepository;
  repoFullName: string;
  historyMap: Map<string, string>;
  now: Date;
  cooldownDays: number;
  breakoutMinStars: number;
  breakoutRecentHours: number;
}): { suppressed: boolean; breakoutAllowed: boolean } {
  if (input.cooldownDays <= 0) {
    return { suppressed: false, breakoutAllowed: false };
  }

  const lastSelectedAt = input.historyMap.get(input.repoFullName);
  if (!lastSelectedAt) {
    return { suppressed: false, breakoutAllowed: false };
  }

  const lastSelectedMs = Date.parse(lastSelectedAt);
  if (!Number.isFinite(lastSelectedMs)) {
    return { suppressed: false, breakoutAllowed: false };
  }

  const cooldownMs = input.cooldownDays * 24 * 60 * 60 * 1000;
  const deltaMs = input.now.getTime() - lastSelectedMs;
  if (deltaMs > cooldownMs) {
    return { suppressed: false, breakoutAllowed: false };
  }

  if (
    isBreakoutUpdate({
      repo: input.repo,
      now: input.now,
      breakoutMinStars: input.breakoutMinStars,
      breakoutRecentHours: input.breakoutRecentHours,
    })
  ) {
    return { suppressed: false, breakoutAllowed: true };
  }

  return { suppressed: true, breakoutAllowed: false };
}

function isBreakoutUpdate(input: {
  repo: GithubRepository;
  now: Date;
  breakoutMinStars: number;
  breakoutRecentHours: number;
}): boolean {
  const stars = typeof input.repo.stargazers_count === "number" ? input.repo.stargazers_count : 0;
  if (stars < input.breakoutMinStars) {
    return false;
  }

  const recentAt = normalizeText(input.repo.pushed_at) || normalizeText(input.repo.updated_at);
  if (!recentAt) {
    return false;
  }

  const recentMs = Date.parse(recentAt);
  if (!Number.isFinite(recentMs)) {
    return false;
  }

  const deltaHours = Math.max(0, (input.now.getTime() - recentMs) / (60 * 60 * 1000));
  return deltaHours <= input.breakoutRecentHours;
}

function resolveRepositoryKey(repo: GithubRepository): string {
  const fullName = normalizeText(repo.full_name);
  if (fullName) {
    return fullName;
  }

  const htmlUrl = normalizeText(repo.html_url);
  if (!htmlUrl) {
    return "";
  }

  try {
    const parsed = new URL(htmlUrl);
    const [owner, name] = parsed.pathname
      .split("/")
      .filter(Boolean)
      .slice(0, 2);
    if (!owner || !name) {
      return "";
    }
    return `${owner}/${name}`;
  } catch {
    return "";
  }
}

function normalizeHistoryMap(input?: Map<string, string> | Record<string, string>): Map<string, string> {
  if (!input) {
    return new Map();
  }
  if (input instanceof Map) {
    return new Map(input);
  }
  return new Map(Object.entries(input));
}

function resolveNowDate(nowIso?: string): Date {
  const timestamp = nowIso ? Date.parse(nowIso) : NaN;
  if (Number.isFinite(timestamp)) {
    return new Date(timestamp);
  }
  return new Date();
}

async function fetchGithubRepositories(input: {
  query: string;
  sort?: GithubSearchSourceConfig["sort"];
  order?: GithubSearchSourceConfig["order"];
  perPage: number;
  githubToken?: string;
  timeoutMs: number;
  retryDelaysMs: number[];
  fetchImpl: typeof fetch;
}): Promise<GithubRepository[]> {
  const query = new URLSearchParams({
    q: input.query,
    sort: input.sort ?? "updated",
    order: input.order ?? "desc",
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
