import { z } from "zod";

import type {
  ItemCategory,
  LlmClassifyScoreFailureStats,
  LlmClassifyScoreMeta,
  LlmClassifyScoreRetryStats,
  NormalizedItem,
} from "../core/types.js";

const itemCategorySchema = z.enum([
  "open-source",
  "tooling",
  "agent",
  "research",
  "industry-news",
  "tutorial",
  "other",
]);

const classifyScoreResultItemSchema = z.object({
  itemId: z.string().min(1),
  category: itemCategorySchema,
  confidence: z.coerce.number().min(0).max(1),
  llmScore: z.coerce.number().min(0).max(100),
  reason: z.string().min(1),
  domainTag: z.string().optional(),
  intentTag: z.string().optional(),
  titleZh: z.string().optional(),
});

const classifyScorePayloadSchema = z.object({
  results: z.array(classifyScoreResultItemSchema).min(1),
});

const DEFAULT_GLOBAL_MAX_CONCURRENCY = 2;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MIN_CONFIDENCE = 0.6;
const RETRY_DELAY_MS = 220;

export interface LlmClassifyScoreSettings {
  enabled: boolean;
  provider: "minimax";
  minimaxApiKey?: string;
  minimaxModel: string;
  timeoutMs: number;
  batchSize: number;
  maxConcurrency: number;
  globalMaxConcurrency?: number;
  minConfidence: number;
  promptVersion: string;
}

export interface BuildLlmClassifyScoreInput {
  items: NormalizedItem[];
  settings: LlmClassifyScoreSettings;
}

export interface BuildLlmClassifyScoreOutput {
  items: NormalizedItem[];
  meta: LlmClassifyScoreMeta;
  warnings: string[];
}

interface MinimaxClientOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  promptVersion: string;
  apiBaseUrl: string;
}

interface BatchExecutionTelemetry {
  batchRetryCount: number;
  splitRetryCount: number;
}

interface BatchExecutionResult {
  itemId: string;
  category: ItemCategory;
  confidence?: number;
  llmScore?: number;
  reason: string;
  domainTag?: string;
  intentTag?: string;
  titleZh?: string;
  llmUsed: boolean;
  fallbackReason?: string;
}

/**
 * 前置节点负责“全量分类 + 全量打分”，并把失败收敛在节点内部，
 * 避免后续 rank/summarize 节点承受 provider 抖动带来的复杂分支。
 */
export async function buildLlmClassifyScore(input: BuildLlmClassifyScoreInput): Promise<BuildLlmClassifyScoreOutput> {
  const startedAt = new Date().toISOString();
  const startedEpoch = Date.now();
  const batchSize = Math.max(1, Math.floor(input.settings.batchSize || DEFAULT_BATCH_SIZE));
  const timeoutMs = Math.max(1_000, Math.floor(input.settings.timeoutMs || DEFAULT_TIMEOUT_MS));
  const minConfidence = clamp(input.settings.minConfidence || DEFAULT_MIN_CONFIDENCE, 0, 1);
  const globalConcurrency = Math.max(1, Math.floor(input.settings.globalMaxConcurrency ?? DEFAULT_GLOBAL_MAX_CONCURRENCY));
  const effectiveConcurrency = Math.max(1, Math.min(Math.floor(input.settings.maxConcurrency || 1), globalConcurrency));

  if (!input.settings.enabled) {
    return {
      items: input.items,
      meta: {
        enabled: false,
        provider: input.settings.provider,
        model: input.settings.minimaxModel,
        promptVersion: input.settings.promptVersion,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        inputCount: input.items.length,
        processedCount: input.items.length,
        fallbackCount: input.items.length,
        fallbackTriggered: true,
        fallbackReason: "llm_classify_score_disabled",
        batchSize,
        timeoutMs,
        effectiveConcurrency,
        llmAppliedCount: 0,
        llmScoreFallbackCount: input.items.length,
      },
      warnings: ["LLM 分类打分已关闭，使用规则分类与规则分"],
    };
  }

  if (!input.settings.minimaxApiKey) {
    return {
      items: input.items,
      meta: {
        enabled: true,
        provider: input.settings.provider,
        model: input.settings.minimaxModel,
        promptVersion: input.settings.promptVersion,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        inputCount: input.items.length,
        processedCount: input.items.length,
        fallbackCount: input.items.length,
        fallbackTriggered: true,
        fallbackReason: "missing_minimax_api_key",
        batchSize,
        timeoutMs,
        effectiveConcurrency,
        llmAppliedCount: 0,
        llmScoreFallbackCount: input.items.length,
      },
      warnings: ["LLM 分类打分已回退规则模式：missing_minimax_api_key"],
    };
  }

  const client = new MiniMaxClassifyScoreClient({
    apiKey: input.settings.minimaxApiKey,
    model: input.settings.minimaxModel,
    timeoutMs,
    promptVersion: input.settings.promptVersion,
    apiBaseUrl:
      process.env.ANTHROPIC_BASE_URL?.trim() ||
      process.env.MINIMAX_API_BASE_URL?.trim() ||
      "https://api.minimaxi.com/anthropic",
  });

  const telemetry: BatchExecutionTelemetry = {
    batchRetryCount: 0,
    splitRetryCount: 0,
  };

  const batches = chunkArray(input.items, batchSize);
  const batchResults = await mapWithConcurrency(batches, effectiveConcurrency, async (batch) =>
    classifyBatchWithResilience({
      batch,
      client,
      minConfidence,
      telemetry,
    }),
  );

  const mergedResults = batchResults.flat();
  const resultById = new Map(mergedResults.map((item) => [item.itemId, item]));

  const failureStats = createEmptyFailureStats();
  let fallbackCount = 0;
  let llmAppliedCount = 0;
  const fallbackReasons: string[] = [];

  const mergedItems = input.items.map((item) => {
    const result = resultById.get(item.id);
    if (!result) {
      fallbackCount += 1;
      failureStats.totalFailed += 1;
      failureStats.other += 1;
      fallbackReasons.push("missing_batch_result");
      return item;
    }

    if (!result.llmUsed) {
      fallbackCount += 1;
      fallbackReasons.push(result.fallbackReason ?? "fallback_unknown");
      applyFailureStatsByReason(failureStats, result.fallbackReason ?? "fallback_unknown");
      return {
        ...item,
        titleZh: normalizeTranslatedTitle(item.title, result.titleZh),
        llmScore: result.llmScore,
        confidence: result.confidence,
        llmClassifyReason: result.reason,
      } satisfies NormalizedItem;
    }

    llmAppliedCount += 1;
    return {
      ...item,
      category: result.category,
      llmScore: result.llmScore,
      confidence: result.confidence,
      domainTag: result.domainTag,
      intentTag: result.intentTag,
      titleZh: normalizeTranslatedTitle(item.title, result.titleZh),
      llmClassifyReason: result.reason,
    } satisfies NormalizedItem;
  });

  const finishedAt = new Date().toISOString();
  const meta: LlmClassifyScoreMeta = {
    enabled: true,
    provider: input.settings.provider,
    model: input.settings.minimaxModel,
    promptVersion: input.settings.promptVersion,
    startedAt,
    finishedAt,
    durationMs: Date.now() - startedEpoch,
    inputCount: input.items.length,
    processedCount: mergedItems.length,
    fallbackCount,
    fallbackTriggered: fallbackCount > 0,
    batchSize,
    timeoutMs,
    effectiveConcurrency,
    llmAppliedCount,
    llmScoreFallbackCount: fallbackCount,
    failureStats,
    retryStats: {
      batchRetryCount: telemetry.batchRetryCount,
      splitRetryCount: telemetry.splitRetryCount,
    },
  };

  const warnings: string[] = [];
  if (fallbackCount > 0) {
    warnings.push(`LLM 分类打分部分回退：${fallbackCount}/${input.items.length}`);
    warnings.push(formatFallbackReasonWarning(fallbackReasons, input.items.length));
  }
  if (failureStats.totalFailed > 0 || failureStats.lowConfidence > 0) {
    warnings.push(formatFailureStatsWarning(failureStats));
  }
  if (telemetry.batchRetryCount > 0 || telemetry.splitRetryCount > 0) {
    warnings.push(`LLM 分类打分重试统计：batch_retry=${telemetry.batchRetryCount}, split_retry=${telemetry.splitRetryCount}`);
  }

  return {
    items: mergedItems,
    meta,
    warnings,
  };
}

async function classifyBatchWithResilience(input: {
  batch: NormalizedItem[];
  client: MiniMaxClassifyScoreClient;
  minConfidence: number;
  telemetry: BatchExecutionTelemetry;
}): Promise<BatchExecutionResult[]> {
  const normalized = await tryClassifyBatch(input.batch, input.client, input.minConfidence, input.telemetry);
  if (normalized.ok) {
    return normalized.results;
  }

  if (input.batch.length <= 1) {
    const item = input.batch[0];
    if (!item) {
      return [];
    }
    return [
      {
        itemId: item.id,
        category: item.category,
        reason: "LLM 分类打分失败，已回退规则结果。",
        llmUsed: false,
        fallbackReason: normalized.reason,
      },
    ];
  }

  input.telemetry.splitRetryCount += 1;
  const mid = Math.ceil(input.batch.length / 2);
  const left = await classifyBatchWithResilience({
    ...input,
    batch: input.batch.slice(0, mid),
  });
  const right = await classifyBatchWithResilience({
    ...input,
    batch: input.batch.slice(mid),
  });
  return [...left, ...right];
}

async function tryClassifyBatch(
  batch: NormalizedItem[],
  client: MiniMaxClassifyScoreClient,
  minConfidence: number,
  telemetry: BatchExecutionTelemetry,
): Promise<{ ok: true; results: BatchExecutionResult[] } | { ok: false; reason: string }> {
  try {
    const first = await client.classifyScoreBatch(batch);
    return {
      ok: true,
      results: normalizeBatchResults(batch, first, minConfidence),
    };
  } catch (firstError) {
    telemetry.batchRetryCount += 1;
    await sleep(RETRY_DELAY_MS);
    try {
      const second = await client.classifyScoreBatch(batch);
      return {
        ok: true,
        results: normalizeBatchResults(batch, second, minConfidence),
      };
    } catch (secondError) {
      const reason = secondError instanceof Error ? secondError.message : String(secondError);
      return {
        ok: false,
        reason,
      };
    }
  }
}

function normalizeBatchResults(
  batch: NormalizedItem[],
  response: Array<z.infer<typeof classifyScoreResultItemSchema>>,
  minConfidence: number,
): BatchExecutionResult[] {
  const byId = new Map(response.map((item) => [item.itemId, item]));

  return batch.map((item) => {
    const llm = byId.get(item.id);
    if (!llm) {
      return {
        itemId: item.id,
        category: item.category,
        reason: "LLM 未返回该条结果，已回退规则。",
        llmUsed: false,
        fallbackReason: "missing_batch_item_result",
      };
    }

    if (llm.confidence < minConfidence) {
      return {
        itemId: item.id,
        category: item.category,
        confidence: llm.confidence,
        llmScore: llm.llmScore,
        reason: llm.reason,
        domainTag: llm.domainTag,
        intentTag: llm.intentTag,
        titleZh: llm.titleZh,
        llmUsed: false,
        fallbackReason: `low_confidence:${llm.confidence.toFixed(2)}<${minConfidence.toFixed(2)}`,
      };
    }

    return {
      itemId: item.id,
      category: llm.category,
      confidence: llm.confidence,
      llmScore: llm.llmScore,
      reason: llm.reason,
      domainTag: llm.domainTag,
      intentTag: llm.intentTag,
      titleZh: llm.titleZh,
      llmUsed: true,
    };
  });
}

function createEmptyFailureStats(): LlmClassifyScoreFailureStats {
  return {
    totalFailed: 0,
    timeout: 0,
    http: 0,
    business: 0,
    missingContent: 0,
    invalidJson: 0,
    quality: 0,
    other: 0,
    lowConfidence: 0,
  };
}

function applyFailureStatsByReason(stats: LlmClassifyScoreFailureStats, reason: string) {
  const lower = reason.toLowerCase();
  if (lower.includes("low_confidence")) {
    stats.lowConfidence += 1;
    return;
  }

  stats.totalFailed += 1;
  if (lower.includes("timeout")) {
    stats.timeout += 1;
    return;
  }
  if (lower.includes("http")) {
    stats.http += 1;
    return;
  }
  if (lower.includes("business")) {
    stats.business += 1;
    return;
  }
  if (lower.includes("missing_content")) {
    stats.missingContent += 1;
    return;
  }
  if (lower.includes("invalid_json")) {
    stats.invalidJson += 1;
    return;
  }
  if (lower.includes("quality") || lower.includes("missing_batch_item_result")) {
    stats.quality += 1;
    return;
  }
  stats.other += 1;
}

function formatFailureStatsWarning(stats: LlmClassifyScoreFailureStats): string {
  return [
    "LLM 分类打分失败分类",
    `low_confidence=${stats.lowConfidence}`,
    `timeout=${stats.timeout}`,
    `http=${stats.http}`,
    `business=${stats.business}`,
    `missing_content=${stats.missingContent}`,
    `invalid_json=${stats.invalidJson}`,
    `quality=${stats.quality}`,
    `other=${stats.other}`,
  ].join("：").replace("：low_confidence", "：low_confidence");
}

function formatFallbackReasonWarning(reasons: string[], total: number): string {
  if (reasons.length === 0) {
    return "LLM 分类打分回退明细：none";
  }
  const sample = reasons.slice(0, 3).join(" | ");
  return `LLM 分类打分回退明细（前 ${Math.min(3, reasons.length)}/${total}）：${sample}`;
}

class MiniMaxClassifyScoreClient {
  constructor(private readonly options: MinimaxClientOptions) {}

  async classifyScoreBatch(batch: NormalizedItem[]): Promise<Array<z.infer<typeof classifyScoreResultItemSchema>>> {
    const url = `${this.options.apiBaseUrl.replace(/\/+$/, "")}/v1/messages`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const payload = {
        model: this.options.model,
        max_tokens: 2200,
        temperature: 0.1,
        system: [
          {
            type: "text",
            text: buildClassifyScoreSystemPrompt(this.options.promptVersion),
          },
        ],
        messages: buildFewShotMessages(batch),
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await safeReadText(response);
        throw new Error(`minimax_http_${response.status}:${body.slice(0, 160)}`);
      }

      const parsed = (await response.json()) as {
        error?: { type?: string; message?: string };
        content?: Array<Record<string, unknown>> | string;
        message?: { content?: string | Array<Record<string, unknown>> };
        choices?: Array<{ message?: { content?: string | Array<Record<string, unknown>> } }>;
      };

      if (parsed.error) {
        const type = parsed.error.type ?? "unknown";
        const message = parsed.error.message ?? "unknown";
        throw new Error(`minimax_business_${type}:${message}`);
      }

      const text = extractModelText(parsed);
      if (!text) {
        throw new Error("minimax_invalid_response:missing_content");
      }

      const json = parseJsonFromModelText(text);
      const normalized = Array.isArray(json) ? { results: json } : json;
      const validated = classifyScorePayloadSchema.parse(normalized);
      return validated.results;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`minimax_timeout:${this.options.timeoutMs}ms`);
      }
      if (error instanceof z.ZodError) {
        throw new Error(`minimax_invalid_json_content:${error.issues[0]?.message ?? "invalid_schema"}`);
      }
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildClassifyScoreSystemPrompt(promptVersion: string): string {
  return [
    `你是 AI 信息编辑助手（promptVersion=${promptVersion}）。`,
    "任务：对输入条目执行分类与评分。",
    "若原标题为英文，需要输出中文标题到 titleZh；中文标题则返回空字符串。",
    "输出必须是 JSON-only，不允许 markdown，不允许解释文字。",
    "分类枚举仅允许：open-source, tooling, agent, research, industry-news, tutorial, other。",
    "评分规则：llmScore 为 0-100，代表工程落地价值与信息密度。",
    "confidence 为 0-1，表示你对分类+评分判断的把握。",
    "reason 用 1 句中文说明主要判断依据。",
    "titleZh 只能是最终中文标题，不得包含 titleZh: 前缀文本。",
    "必须为每个 itemId 返回且只返回一条结果。",
  ].join("\n");
}

function buildFewShotMessages(batch: NormalizedItem[]): Array<{ role: "user" | "assistant"; content: Array<{ type: "text"; text: string }> }> {
  const fewShotUser = {
    task: "classify_and_score",
    items: [
      {
        itemId: "demo-1",
        title: "LangGraph 发布 multi-agent orchestration 指南",
        snippet: "强调多 Agent 编排实践、可观测和生产部署策略。",
      },
      {
        itemId: "demo-2",
        title: "公司发布季度财报并披露 AI 投入",
        snippet: "偏行业新闻与市场动态。",
      },
    ],
  };

  const fewShotAssistant = {
    results: [
      {
        itemId: "demo-1",
        category: "agent",
        confidence: 0.93,
        llmScore: 88,
        reason: "内容聚焦 Agent 编排工程实践，具备直接落地参考价值。",
        domainTag: "agent",
        intentTag: "guide",
        titleZh: "LangGraph 发布多 Agent 编排指南",
      },
      {
        itemId: "demo-2",
        category: "industry-news",
        confidence: 0.89,
        llmScore: 62,
        reason: "以行业动态与企业披露为主，工程细节相对有限。",
        domainTag: "industry",
        intentTag: "news",
        titleZh: "",
      },
    ],
  };

  const runtimeUser = {
    task: "classify_and_score",
    items: batch.map((item) => ({
      itemId: item.id,
      title: item.title,
      snippet: shorten(item.contentSnippet, 220),
      ruleCategory: item.category,
    })),
  };

  return [
    { role: "user", content: [{ type: "text", text: JSON.stringify(fewShotUser) }] },
    { role: "assistant", content: [{ type: "text", text: JSON.stringify(fewShotAssistant) }] },
    { role: "user", content: [{ type: "text", text: JSON.stringify(runtimeUser) }] },
  ];
}

function shorten(input: string, limit: number): string {
  const normalized = (input || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function extractModelText(
  payload: {
    content?: Array<Record<string, unknown>> | string;
    message?: { content?: string | Array<Record<string, unknown>> };
    choices?: Array<{ message?: { content?: string | Array<Record<string, unknown>> } }>;
  },
): string | null {
  if (typeof payload.content === "string" && payload.content.trim()) {
    return payload.content.trim();
  }
  if (Array.isArray(payload.content)) {
    const fromBlocks = extractTextFromBlocks(payload.content);
    if (fromBlocks) {
      return fromBlocks;
    }
  }

  const messageContent = payload.message?.content;
  if (typeof messageContent === "string" && messageContent.trim()) {
    return messageContent.trim();
  }
  if (Array.isArray(messageContent)) {
    const fromBlocks = extractTextFromBlocks(messageContent);
    if (fromBlocks) {
      return fromBlocks;
    }
  }

  const choiceContent = payload.choices?.[0]?.message?.content;
  if (typeof choiceContent === "string" && choiceContent.trim()) {
    return choiceContent.trim();
  }
  if (Array.isArray(choiceContent)) {
    const fromBlocks = extractTextFromBlocks(choiceContent);
    if (fromBlocks) {
      return fromBlocks;
    }
  }
  return null;
}

function extractTextFromBlocks(blocks: Array<Record<string, unknown>>): string | null {
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text.trim());
      continue;
    }
    if (typeof block.content === "string" && block.content.trim()) {
      parts.push(block.content.trim());
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n").trim();
}

function parseJsonFromModelText(input: string): unknown {
  const trimmed = input.trim();
  const strippedFence = stripMarkdownFence(trimmed);

  try {
    const direct = JSON.parse(strippedFence);
    // 兼容 provider 把 JSON 再包一层字符串返回的场景（escaped JSON 字符串）。
    if (typeof direct === "string") {
      return JSON.parse(direct);
    }
    return direct;
  } catch {
    // pass
  }

  const decoded = decodeEscapedJsonLikeText(strippedFence);
  try {
    return JSON.parse(decoded);
  } catch {
    // pass
  }

  const start = decoded.indexOf("{");
  const end = decoded.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = decoded.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // pass
    }
  }

  const arrStart = decoded.indexOf("[");
  const arrEnd = decoded.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) {
    const candidate = decoded.slice(arrStart, arrEnd + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // pass
    }
  }

  throw new Error("minimax_invalid_json_content");
}

function stripMarkdownFence(input: string): string {
  const matched = input.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return matched?.[1]?.trim() ?? input;
}

function decodeEscapedJsonLikeText(input: string): string {
  const normalized = input.trim();
  if (!normalized.startsWith("\"") || !normalized.endsWith("\"")) {
    return normalized;
  }
  try {
    const decoded = JSON.parse(normalized);
    return typeof decoded === "string" ? decoded : normalized;
  } catch {
    return normalized;
  }
}

function chunkArray<T>(input: T[], size: number): T[][] {
  if (input.length === 0) {
    return [];
  }
  const chunks: T[][] = [];
  for (let i = 0; i < input.length; i += size) {
    chunks.push(input.slice(i, i + size));
  }
  return chunks;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current] as T, current);
    }
  }

  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runWorker());
  await Promise.all(runners);
  return results;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeTranslatedTitle(originalTitle: string, translatedTitle: string | undefined): string | undefined {
  if (!translatedTitle) {
    return undefined;
  }
  const normalized = translatedTitle.trim();
  if (!normalized || normalized === originalTitle) {
    return undefined;
  }
  // titleZh 作为“中文增强”字段，若返回值完全不含中文则忽略，避免把英文改写误当作翻译结果。
  if (!/[\u4e00-\u9fff]/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export const __test__ = {
  parseJsonFromModelText,
  stripMarkdownFence,
  decodeEscapedJsonLikeText,
  normalizeBatchResults,
};
