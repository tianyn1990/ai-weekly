import { z } from "zod";

import { createEmptyMetrics, normalizeWhitespace } from "../core/utils.js";
import type {
  FeedbackCandidateAddition,
  FeedbackCandidateRemoval,
  ItemCategory,
  RankedItem,
  ReportMode,
  ReviewFeedbackPayload,
  ReviewInstruction,
  RevisionAuditLog,
} from "../core/types.js";
import { executeFeedbackRevision } from "./feedback-executor.js";

const revisionOperationSchema = z.enum([
  "add_candidate",
  "remove_candidate",
  "update_item_title_zh",
  "update_item_summary",
  "update_item_recommendation",
  "update_item_category",
  "set_item_importance",
  "add_topic",
  "add_search_term",
  "set_source_toggle",
  "set_source_weight",
  "set_ranking_weight",
  "add_module",
  "remove_module",
  "reorder_module",
  "rewrite_module_lead",
]);

const revisionTaskSchema = z.object({
  id: z.string().min(1).optional(),
  operation: revisionOperationSchema,
  target: z
    .object({
      itemId: z.string().optional(),
      evidenceId: z.string().optional(),
      link: z.string().url().optional(),
      titleKeyword: z.string().optional(),
      category: z.enum(["open-source", "tooling", "agent", "research", "industry-news", "tutorial", "other"]).optional(),
      module: z.string().optional(),
    })
    .optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  requiresClarification: z.boolean().optional(),
  reason: z.string().optional(),
});

const revisionPlannerOutputSchema = z.object({
  tasks: z.array(revisionTaskSchema).min(1),
});

export type RevisionFailureCategory =
  | "planning_failed"
  | "ambiguous_target"
  | "target_not_found"
  | "tool_execution_failed"
  | "validation_failed"
  | "step_limit_reached"
  | "wall_clock_timeout";

interface RevisionTask extends z.infer<typeof revisionTaskSchema> {
  id: string;
}

interface ItemPatch {
  titleZh?: string;
  contentSnippet?: string;
  recommendationReason?: string;
  category?: ItemCategory;
  importance?: "high" | "medium" | "low";
}

interface ToolExecutionResult {
  ok: boolean;
  category?: RevisionFailureCategory;
  reason?: string;
}

interface RevisionCheckpointPayload {
  version: 1;
  pendingTasks: RevisionTask[];
  failureCategory?: RevisionFailureCategory;
}

export interface RevisionAgentSettings {
  enabled: boolean;
  maxSteps: number;
  maxWallClockMs: number;
  maxLlmCalls: number;
  maxToolErrors: number;
  plannerTimeoutMs: number;
}

export interface ExecuteRevisionWithAgentInput {
  mode: ReportMode;
  generatedAt: string;
  sourceConfigPath: string;
  runtimeConfigPath: string;
  storageBackend: "file" | "db";
  storageDbPath: string;
  storageFallbackToFile: boolean;
  rankedItems: RankedItem[];
  metrics: {
    collectedCount: number;
    normalizedCount: number;
    dedupedCount: number;
    highImportanceCount: number;
    mediumImportanceCount: number;
    lowImportanceCount: number;
    categoryBreakdown: Record<ItemCategory, number>;
  };
  instruction: ReviewInstruction;
  revisionAuditLogs: RevisionAuditLog[];
  settings: RevisionAgentSettings;
  llm: {
    provider: "minimax";
    apiKey?: string;
    model: string;
  };
}

export interface ExecuteRevisionWithAgentResult {
  rankedItems: RankedItem[];
  highlights: RankedItem[];
  metrics: ExecuteRevisionWithAgentInput["metrics"];
  auditLog: RevisionAuditLog;
  warnings: string[];
  failureCategory?: RevisionFailureCategory;
  hasPendingTasks: boolean;
}

const CHECKPOINT_NOTE_PREFIX = "react_checkpoint:";
const MIN_CONFIDENCE_TO_AUTO_EXECUTE = 0.45;
const RETRY_BASE_DELAY_MS = 180;
const RETRY_MAX_DELAY_MS = 900;
const DEFAULT_PLANNER_RETRY_TIMES = 3;

/**
 * 修订 Agent 采用“LLM 规划 + 受限工具执行”的模式：
 * 1) 用自由文本生成结构化任务；
 * 2) 仅允许白名单操作落到结构化快照；
 * 3) 最后统一走既有修订执行器做重排与审计。
 */
export async function executeRevisionWithAgent(input: ExecuteRevisionWithAgentInput): Promise<ExecuteRevisionWithAgentResult> {
  const feedback = input.instruction.feedback ?? createImplicitFeedbackFromReason(input.instruction.reason);
  if (!feedback) {
    const fallback = await executeFeedbackRevision({
      mode: input.mode,
      generatedAt: input.generatedAt,
      sourceConfigPath: input.sourceConfigPath,
      runtimeConfigPath: input.runtimeConfigPath,
      storageBackend: input.storageBackend,
      storageDbPath: input.storageDbPath,
      storageFallbackToFile: input.storageFallbackToFile,
      rankedItems: input.rankedItems,
      metrics: input.metrics,
      instruction: input.instruction,
    });
    return {
      ...fallback,
      warnings: [],
      hasPendingTasks: false,
    };
  }

  if (!input.settings.enabled) {
    const fallback = await executeFeedbackRevision({
      mode: input.mode,
      generatedAt: input.generatedAt,
      sourceConfigPath: input.sourceConfigPath,
      runtimeConfigPath: input.runtimeConfigPath,
      storageBackend: input.storageBackend,
      storageDbPath: input.storageDbPath,
      storageFallbackToFile: input.storageFallbackToFile,
      rankedItems: input.rankedItems,
      metrics: input.metrics,
      instruction: input.instruction,
    });
    return {
      ...fallback,
      warnings: ["修订 Agent 已关闭，已回退结构化修订执行。"],
      hasPendingTasks: false,
    };
  }

  const warnings: string[] = [];
  let llmCalls = 0;
  const startedAtMs = Date.now();

  const plannedTasks = await resolvePlannedTasks({
    feedback,
    instruction: input.instruction,
    rankedItems: input.rankedItems,
    previousLogs: input.revisionAuditLogs,
    planner: async (requestText) => {
      if (!input.llm.apiKey || llmCalls >= input.settings.maxLlmCalls) {
        throw new Error(!input.llm.apiKey ? "planning_failed:missing_minimax_api_key" : "planning_failed:max_llm_calls_reached");
      }
      llmCalls += 1;
      return await planTasksWithMiniMax({
        requestText,
        items: input.rankedItems,
        apiKey: input.llm.apiKey,
        model: input.llm.model,
        timeoutMs: input.settings.plannerTimeoutMs,
      });
    },
  });

  if (!plannedTasks.ok) {
    const auditLog = buildAgentAuditLog({
      input,
      addedCount: 0,
      removedCount: 0,
      beforeCount: input.rankedItems.length,
      afterCount: input.rankedItems.length,
      globalConfigChanges: [],
      checkpoint: undefined,
      notes: `planning_failed:${plannedTasks.reason}`,
    });
    return {
      rankedItems: input.rankedItems,
      highlights: pickHighlights(input.rankedItems, input.mode),
      metrics: rebuildMetrics(input.metrics, input.rankedItems),
      auditLog,
      warnings: [`修订任务规划失败：${plannedTasks.reason}`],
      failureCategory: "planning_failed",
      hasPendingTasks: false,
    };
  }

  const feedbackAccumulator: ReviewFeedbackPayload = {
    candidateAdditions: [...(feedback.candidateAdditions ?? [])],
    candidateRemovals: [...(feedback.candidateRemovals ?? [])],
    newTopics: [...(feedback.newTopics ?? [])],
    newSearchTerms: [...(feedback.newSearchTerms ?? [])],
    sourceToggles: [...(feedback.sourceToggles ?? [])],
    sourceWeightAdjustments: [...(feedback.sourceWeightAdjustments ?? [])],
    rankingWeightAdjustments: [...(feedback.rankingWeightAdjustments ?? [])],
    editorNotes: feedback.editorNotes,
  };

  const itemPatches = new Map<string, ItemPatch>();
  const pendingTasks = [...plannedTasks.tasks];
  let toolErrors = 0;
  let failureCategory: RevisionFailureCategory | undefined;
  let lastFailureReason: string | undefined;
  let steps = 0;

  while (pendingTasks.length > 0) {
    if (steps >= input.settings.maxSteps) {
      failureCategory = "step_limit_reached";
      lastFailureReason = `max_steps=${input.settings.maxSteps}`;
      break;
    }
    if (Date.now() - startedAtMs > input.settings.maxWallClockMs) {
      failureCategory = "wall_clock_timeout";
      lastFailureReason = `max_wall_clock_ms=${input.settings.maxWallClockMs}`;
      break;
    }
    if (toolErrors > input.settings.maxToolErrors) {
      failureCategory = "tool_execution_failed";
      lastFailureReason = `max_tool_errors=${input.settings.maxToolErrors}`;
      break;
    }

    const task = pendingTasks.shift() as RevisionTask;
    steps += 1;
    const execution = applyRevisionTask({
      task,
      rankedItems: input.rankedItems,
      feedbackAccumulator,
      itemPatches,
    });

    if (!execution.ok) {
      toolErrors += 1;
      failureCategory = execution.category ?? "tool_execution_failed";
      lastFailureReason = execution.reason ?? "unknown";
      warnings.push(`修订任务失败（${task.id}/${task.operation}）：${lastFailureReason}`);
    }
  }

  const checkpoint = pendingTasks.length > 0 ? createCheckpointPayload(pendingTasks, failureCategory) : undefined;
  if (checkpoint) {
    warnings.push(`修订任务未全部完成，待续任务=${checkpoint.pendingTasks.length}`);
  }

  const revised = await executeFeedbackRevision({
    mode: input.mode,
    generatedAt: input.generatedAt,
    sourceConfigPath: input.sourceConfigPath,
    runtimeConfigPath: input.runtimeConfigPath,
    storageBackend: input.storageBackend,
    storageDbPath: input.storageDbPath,
    storageFallbackToFile: input.storageFallbackToFile,
    rankedItems: input.rankedItems,
    metrics: input.metrics,
    instruction: {
      ...input.instruction,
      feedback: feedbackAccumulator,
    },
  });

  const patchedItems = applyItemPatches(revised.rankedItems, itemPatches);
  const metrics = rebuildMetrics(input.metrics, patchedItems);
  const highlights = pickHighlights(patchedItems, input.mode);
  const checkpointNote = checkpoint ? `${CHECKPOINT_NOTE_PREFIX}${JSON.stringify(checkpoint)}` : undefined;
  const auditLog = buildAgentAuditLog({
    input,
    addedCount: revised.auditLog.addedCount,
    removedCount: revised.auditLog.removedCount,
    beforeCount: revised.auditLog.beforeCount,
    afterCount: patchedItems.length,
    globalConfigChanges: revised.auditLog.globalConfigChanges,
    checkpoint,
    notes: [
      revised.auditLog.notes,
      checkpointNote,
      failureCategory ? `failure_category=${failureCategory}` : undefined,
      lastFailureReason ? `failure_reason=${lastFailureReason}` : undefined,
      `steps=${steps}`,
      `llm_calls=${llmCalls}`,
    ]
      .filter(Boolean)
      .join(" | "),
  });

  return {
    rankedItems: patchedItems,
    highlights,
    metrics,
    auditLog,
    warnings,
    failureCategory,
    hasPendingTasks: pendingTasks.length > 0,
  };
}

function createImplicitFeedbackFromReason(reason: string | undefined): ReviewFeedbackPayload | undefined {
  const text = normalizeWhitespace(reason ?? "");
  if (!text) {
    return undefined;
  }
  // 历史卡片仅传 reason；这里自动映射为 revisionRequest，保证单按钮场景也能触发 Agent 规划。
  return {
    revisionRequest: text,
    revisionScope: "all",
    revisionIntent: "general_refine",
  };
}

async function resolvePlannedTasks(input: {
  feedback: ReviewFeedbackPayload;
  instruction: ReviewInstruction;
  rankedItems: RankedItem[];
  previousLogs: RevisionAuditLog[];
  planner: (requestText: string) => Promise<RevisionTask[]>;
}): Promise<{ ok: true; tasks: RevisionTask[] } | { ok: false; reason: string }> {
  // continueFromCheckpoint=true 时优先恢复未完成任务，避免已成功步骤被重复执行。
  if (input.feedback.continueFromCheckpoint) {
    const checkpointTasks = loadCheckpointTasks(input.previousLogs);
    if (checkpointTasks.length > 0) {
      return { ok: true, tasks: checkpointTasks };
    }
  }

  const requestText =
    normalizeWhitespace(input.feedback.revisionRequest ?? "") ||
    normalizeWhitespace(input.instruction.reason ?? "") ||
    normalizeWhitespace(input.feedback.editorNotes ?? "");

  if (!requestText) {
    // 没有自由文本时，降级为“结构化字段直连执行”，这里返回空任务。
    return { ok: true, tasks: [] };
  }

  const heuristicTasks = buildTasksByHeuristic(requestText);
  try {
    const planned = await input.planner(requestText);
    return { ok: true, tasks: planned.length > 0 ? planned : heuristicTasks };
  } catch (error) {
    if (heuristicTasks.length > 0) {
      return { ok: true, tasks: heuristicTasks };
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function loadCheckpointTasks(logs: RevisionAuditLog[]): RevisionTask[] {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const notes = logs[i]?.notes;
    if (!notes || !notes.includes(CHECKPOINT_NOTE_PREFIX)) {
      continue;
    }
    const raw = notes.slice(notes.indexOf(CHECKPOINT_NOTE_PREFIX) + CHECKPOINT_NOTE_PREFIX.length);
    try {
      const parsed = JSON.parse(raw) as RevisionCheckpointPayload;
      if (!parsed || !Array.isArray(parsed.pendingTasks)) {
        continue;
      }
      return parsed.pendingTasks
        .map((task, index) => normalizeTask(task, `resume-${index + 1}`))
        .filter((task): task is RevisionTask => Boolean(task));
    } catch {
      // 历史 notes 可能含混合文本，解析失败时保持 fail-soft。
      continue;
    }
  }
  return [];
}

function applyRevisionTask(input: {
  task: RevisionTask;
  rankedItems: RankedItem[];
  feedbackAccumulator: ReviewFeedbackPayload;
  itemPatches: Map<string, ItemPatch>;
}): ToolExecutionResult {
  // 所有自动执行都受置信度门控，低置信度任务直接要求人工澄清，防止误改。
  const task = input.task;
  if (task.requiresClarification || (task.confidence ?? 1) < MIN_CONFIDENCE_TO_AUTO_EXECUTE) {
    return {
      ok: false,
      category: "ambiguous_target",
      reason: "任务置信度不足或需要澄清，已暂停自动执行",
    };
  }

  if (task.operation === "add_candidate") {
    const title = asString(task.payload?.title);
    if (!title) {
      return { ok: false, category: "validation_failed", reason: "add_candidate 缺少 title" };
    }
    const addition: FeedbackCandidateAddition = {
      title,
      ...(asString(task.payload?.link) ? { link: asString(task.payload?.link) } : {}),
      ...(asString(task.payload?.summary) ? { summary: asString(task.payload?.summary) } : {}),
      ...(asCategory(task.payload?.category) ? { category: asCategory(task.payload?.category) } : {}),
      ...(asString(task.payload?.sourceId) ? { sourceId: asString(task.payload?.sourceId) } : {}),
      ...(asString(task.payload?.sourceName) ? { sourceName: asString(task.payload?.sourceName) } : {}),
    };
    input.feedbackAccumulator.candidateAdditions = [...(input.feedbackAccumulator.candidateAdditions ?? []), addition];
    return { ok: true };
  }

  if (task.operation === "remove_candidate") {
    const matches = locateItems(task.target, input.rankedItems);
    if (matches.length === 0) {
      return { ok: false, category: "target_not_found", reason: "remove_candidate 未命中条目" };
    }
    const removals: FeedbackCandidateRemoval[] = matches.map((item) => ({ id: item.id, link: item.link }));
    input.feedbackAccumulator.candidateRemovals = [...(input.feedbackAccumulator.candidateRemovals ?? []), ...removals];
    return { ok: true };
  }

  if (task.operation === "add_topic") {
    const topic = asString(task.payload?.topic) ?? asString(task.payload?.value);
    if (!topic) {
      return { ok: false, category: "validation_failed", reason: "add_topic 缺少 topic" };
    }
    input.feedbackAccumulator.newTopics = dedupeStrings([...(input.feedbackAccumulator.newTopics ?? []), topic]);
    return { ok: true };
  }

  if (task.operation === "add_search_term") {
    const term = asString(task.payload?.term) ?? asString(task.payload?.value);
    if (!term) {
      return { ok: false, category: "validation_failed", reason: "add_search_term 缺少 term" };
    }
    input.feedbackAccumulator.newSearchTerms = dedupeStrings([...(input.feedbackAccumulator.newSearchTerms ?? []), term]);
    return { ok: true };
  }

  if (task.operation === "set_source_toggle") {
    const sourceId = asString(task.payload?.sourceId);
    const enabled = asBoolean(task.payload?.enabled);
    if (!sourceId || typeof enabled !== "boolean") {
      return { ok: false, category: "validation_failed", reason: "set_source_toggle 缺少 sourceId/enabled" };
    }
    input.feedbackAccumulator.sourceToggles = [...(input.feedbackAccumulator.sourceToggles ?? []), { sourceId, enabled }];
    return { ok: true };
  }

  if (task.operation === "set_source_weight") {
    const sourceId = asString(task.payload?.sourceId);
    const weight = asNumber(task.payload?.weight);
    if (!sourceId || typeof weight !== "number") {
      return { ok: false, category: "validation_failed", reason: "set_source_weight 缺少 sourceId/weight" };
    }
    input.feedbackAccumulator.sourceWeightAdjustments = [
      ...(input.feedbackAccumulator.sourceWeightAdjustments ?? []),
      { sourceId, weight },
    ];
    return { ok: true };
  }

  if (task.operation === "set_ranking_weight") {
    const dimension = asRankingDimension(task.payload?.dimension);
    const weight = asNumber(task.payload?.weight);
    if (!dimension || typeof weight !== "number") {
      return { ok: false, category: "validation_failed", reason: "set_ranking_weight 缺少 dimension/weight" };
    }
    input.feedbackAccumulator.rankingWeightAdjustments = [
      ...(input.feedbackAccumulator.rankingWeightAdjustments ?? []),
      { dimension, weight },
    ];
    return { ok: true };
  }

  if (
    task.operation === "update_item_title_zh" ||
    task.operation === "update_item_summary" ||
    task.operation === "update_item_recommendation" ||
    task.operation === "update_item_category" ||
    task.operation === "set_item_importance"
  ) {
    const matches = locateItems(task.target, input.rankedItems);
    if (matches.length === 0) {
      return { ok: false, category: "target_not_found", reason: `${task.operation} 未命中条目` };
    }
    if (matches.length > 1) {
      return { ok: false, category: "ambiguous_target", reason: `${task.operation} 命中多个条目，请补充定位信息` };
    }
    const matched = matches[0] as RankedItem;
    const previous = input.itemPatches.get(matched.id) ?? {};
    if (task.operation === "update_item_title_zh") {
      const value = asString(task.payload?.titleZh) ?? asString(task.payload?.value);
      if (!value) {
        return { ok: false, category: "validation_failed", reason: "update_item_title_zh 缺少 titleZh" };
      }
      input.itemPatches.set(matched.id, { ...previous, titleZh: value });
      return { ok: true };
    }
    if (task.operation === "update_item_summary") {
      const value = asString(task.payload?.summary) ?? asString(task.payload?.value);
      if (!value) {
        return { ok: false, category: "validation_failed", reason: "update_item_summary 缺少 summary" };
      }
      input.itemPatches.set(matched.id, { ...previous, contentSnippet: value });
      return { ok: true };
    }
    if (task.operation === "update_item_recommendation") {
      const value = asString(task.payload?.recommendation) ?? asString(task.payload?.value);
      if (!value) {
        return { ok: false, category: "validation_failed", reason: "update_item_recommendation 缺少 recommendation" };
      }
      input.itemPatches.set(matched.id, { ...previous, recommendationReason: value });
      return { ok: true };
    }
    if (task.operation === "update_item_category") {
      const category = asCategory(task.payload?.category);
      if (!category) {
        return { ok: false, category: "validation_failed", reason: "update_item_category 缺少合法 category" };
      }
      input.itemPatches.set(matched.id, { ...previous, category });
      return { ok: true };
    }

    const importance = asImportance(task.payload?.importance);
    if (!importance) {
      return { ok: false, category: "validation_failed", reason: "set_item_importance 缺少合法 importance" };
    }
    input.itemPatches.set(matched.id, { ...previous, importance });
    return { ok: true };
  }

  // “模块类操作”先作为可追踪备注落盘，避免在未引入结构化 module schema 时误改正文。
  if (
    task.operation === "add_module" ||
    task.operation === "remove_module" ||
    task.operation === "reorder_module" ||
    task.operation === "rewrite_module_lead"
  ) {
    const notes = [input.feedbackAccumulator.editorNotes, `module_operation:${task.operation}`].filter(Boolean).join(" | ");
    input.feedbackAccumulator.editorNotes = notes;
    return { ok: true };
  }

  return { ok: false, category: "tool_execution_failed", reason: `unsupported_operation:${task.operation}` };
}

function locateItems(
  target: RevisionTask["target"] | undefined,
  items: RankedItem[],
): RankedItem[] {
  if (!target) {
    return [];
  }
  const byId = target.itemId ?? target.evidenceId;
  if (byId) {
    return items.filter((item) => item.id === byId);
  }
  if (target.link) {
    return items.filter((item) => item.link === target.link);
  }
  if (target.titleKeyword) {
    const keyword = target.titleKeyword.toLowerCase();
    return items.filter((item) => item.title.toLowerCase().includes(keyword) || (item.titleZh ?? "").toLowerCase().includes(keyword));
  }
  if (target.category) {
    return items.filter((item) => item.category === target.category);
  }
  return [];
}

function applyItemPatches(items: RankedItem[], patches: Map<string, ItemPatch>): RankedItem[] {
  if (patches.size === 0) {
    return items;
  }
  return items.map((item) => {
    const patch = patches.get(item.id);
    if (!patch) {
      return item;
    }
    const score = patch.importance ? scoreByImportance(patch.importance) : item.score;
    return {
      ...item,
      ...(patch.titleZh ? { titleZh: patch.titleZh } : {}),
      ...(patch.contentSnippet ? { contentSnippet: patch.contentSnippet } : {}),
      ...(patch.recommendationReason ? { recommendationReason: patch.recommendationReason } : {}),
      ...(patch.category ? { category: patch.category } : {}),
      ...(patch.importance ? { importance: patch.importance, score } : {}),
    };
  });
}

function scoreByImportance(importance: "high" | "medium" | "low"): number {
  if (importance === "high") return 90;
  if (importance === "medium") return 70;
  return 50;
}

function rebuildMetrics(
  base: ExecuteRevisionWithAgentInput["metrics"],
  rankedItems: RankedItem[],
): ExecuteRevisionWithAgentInput["metrics"] {
  const metrics = createEmptyMetrics();
  metrics.collectedCount = base.collectedCount;
  metrics.normalizedCount = rankedItems.length;
  metrics.dedupedCount = rankedItems.length;
  metrics.highImportanceCount = rankedItems.filter((item) => item.importance === "high").length;
  metrics.mediumImportanceCount = rankedItems.filter((item) => item.importance === "medium").length;
  metrics.lowImportanceCount = rankedItems.filter((item) => item.importance === "low").length;
  for (const item of rankedItems) {
    metrics.categoryBreakdown[item.category] += 1;
  }
  return metrics;
}

function pickHighlights(items: RankedItem[], mode: ReportMode): RankedItem[] {
  return items.slice(0, mode === "weekly" ? 8 : 5);
}

function buildAgentAuditLog(input: {
  input: ExecuteRevisionWithAgentInput;
  addedCount: number;
  removedCount: number;
  beforeCount: number;
  afterCount: number;
  globalConfigChanges: string[];
  checkpoint?: RevisionCheckpointPayload;
  notes?: string;
}): RevisionAuditLog {
  return {
    at: input.input.generatedAt,
    stage: input.input.instruction.stage,
    operator: input.input.instruction.operator,
    reason: input.input.instruction.reason,
    beforeCount: input.beforeCount,
    afterCount: input.afterCount,
    addedCount: input.addedCount,
    removedCount: input.removedCount,
    globalConfigChanges: input.globalConfigChanges,
    notes: input.notes,
  };
}

function createCheckpointPayload(pendingTasks: RevisionTask[], failureCategory?: RevisionFailureCategory): RevisionCheckpointPayload {
  return {
    version: 1,
    pendingTasks,
    ...(failureCategory ? { failureCategory } : {}),
  };
}

function normalizeTask(task: z.infer<typeof revisionTaskSchema>, fallbackId: string): RevisionTask | null {
  const parsed = revisionTaskSchema.safeParse(task);
  if (!parsed.success) {
    return null;
  }
  return {
    ...parsed.data,
    id: parsed.data.id ?? fallbackId,
  };
}

function buildTasksByHeuristic(requestText: string): RevisionTask[] {
  const sentences = requestText
    .split(/[\n;；。]/)
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean);
  const tasks: RevisionTask[] = [];
  for (const sentence of sentences) {
    const urlMatch = sentence.match(/https?:\/\/\S+/i);
    if (/新增/.test(sentence)) {
      const title = sentence.replace(/新增|补充/g, "").replace(urlMatch?.[0] ?? "", "").trim();
      tasks.push({
        id: `heuristic-${tasks.length + 1}`,
        operation: "add_candidate",
        payload: {
          title: title || "人工补充条目",
          ...(urlMatch?.[0] ? { link: urlMatch[0] } : {}),
        },
        confidence: 0.72,
      });
      continue;
    }
    if (/删除|移除/.test(sentence)) {
      tasks.push({
        id: `heuristic-${tasks.length + 1}`,
        operation: "remove_candidate",
        target: urlMatch?.[0] ? { link: urlMatch[0] } : { titleKeyword: sentence.replace(/删除|移除/g, "").trim() },
        confidence: 0.62,
      });
      continue;
    }
    if (/主题/.test(sentence)) {
      tasks.push({
        id: `heuristic-${tasks.length + 1}`,
        operation: "add_topic",
        payload: { topic: sentence.replace(/新增|补充|主题|：|:/g, "").trim() || sentence },
        confidence: 0.68,
      });
      continue;
    }
    if (/搜索词|关键词/.test(sentence)) {
      tasks.push({
        id: `heuristic-${tasks.length + 1}`,
        operation: "add_search_term",
        payload: { term: sentence.replace(/新增|补充|搜索词|关键词|：|:/g, "").trim() || sentence },
        confidence: 0.68,
      });
      continue;
    }
    tasks.push({
      id: `heuristic-${tasks.length + 1}`,
      operation: "rewrite_module_lead",
      payload: { note: sentence },
      confidence: 0.5,
    });
  }
  return tasks;
}

async function planTasksWithMiniMax(input: {
  requestText: string;
  items: RankedItem[];
  apiKey: string;
  model: string;
  timeoutMs: number;
}): Promise<RevisionTask[]> {
  const url = `${(process.env.ANTHROPIC_BASE_URL?.trim() || process.env.MINIMAX_API_BASE_URL?.trim() || "https://api.minimaxi.com/anthropic").replace(/\/+$/, "")}/v1/messages`;
  const items = input.items.slice(0, 12).map((item) => ({
    itemId: item.id,
    title: item.title,
    category: item.category,
    link: item.link,
  }));

  // Planner 失败时只重试可恢复错误（timeout/429/5xx/空内容/可修复 JSON）。
  let lastError: unknown;
  for (let attempt = 1; attempt <= DEFAULT_PLANNER_RETRY_TIMES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": input.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: input.model,
          max_tokens: 2600,
          temperature: 0.1,
          system: [
            {
              type: "text",
              text: buildRevisionPlannerSystemPrompt(),
            },
          ],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    revisionRequest: input.requestText,
                    topItems: items,
                  }),
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await safeReadText(response);
        throw new Error(`planning_failed:http_${response.status}:${body.slice(0, 200)}`);
      }
      const parsed = (await response.json()) as {
        error?: { type?: string; message?: string };
        content?: Array<Record<string, unknown>> | string;
        message?: { content?: string | Array<Record<string, unknown>> };
        choices?: Array<{ message?: { content?: string | Array<Record<string, unknown>> } }>;
      };
      if (parsed.error) {
        throw new Error(`planning_failed:business_${parsed.error.type ?? "unknown"}:${parsed.error.message ?? "unknown"}`);
      }
      const text = extractModelText(parsed);
      if (!text) {
        throw new Error("planning_failed:missing_content");
      }
      const json = parseJsonFromModelText(text);
      const validated = revisionPlannerOutputSchema.parse(json);
      return validated.tasks
        .map((task, index) => normalizeTask(task, `plan-${index + 1}`))
        .filter((task): task is RevisionTask => Boolean(task));
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.name === "AbortError") {
        lastError = new Error(`planning_failed:timeout_${input.timeoutMs}ms`);
      }
      if (attempt >= DEFAULT_PLANNER_RETRY_TIMES || !isPlannerRetryable(lastError)) {
        break;
      }
      await sleep(Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function buildRevisionPlannerSystemPrompt(): string {
  return [
    "你是报告修订 Planner。",
    "任务：把自然语言修订意见拆解成可执行任务 tasks。",
    "只允许输出单个 JSON object，禁止 markdown、禁止 code fence、禁止额外解释文本。",
    "输出前必须自检 JSON.parse 可通过。",
    "operation 仅可取：add_candidate/remove_candidate/update_item_title_zh/update_item_summary/update_item_recommendation/update_item_category/set_item_importance/add_topic/add_search_term/set_source_toggle/set_source_weight/set_ranking_weight/add_module/remove_module/reorder_module/rewrite_module_lead。",
    "每个 task 至少包含 operation；如可定位目标请填 target；如需要参数请填 payload。",
    "confidence 填 0-1；若信息不足需人工确认，请设置 requiresClarification=true。",
    "返回格式：{\"tasks\":[...]}。",
  ].join("\n");
}

function isPlannerRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("planning_failed:timeout") ||
    message.includes("planning_failed:http_429") ||
    message.includes("planning_failed:http_500") ||
    message.includes("planning_failed:http_502") ||
    message.includes("planning_failed:http_503") ||
    message.includes("planning_failed:http_504") ||
    message.includes("minimax_invalid_json_content") ||
    message.includes("planning_failed:missing_content")
  );
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
  return parts.length === 0 ? null : parts.join("\n");
}

function parseJsonFromModelText(input: string): unknown {
  const trimmed = input.trim();
  // 兼容模型常见脏输出：```json 包裹、字符串转义 JSON、前后解释文本拼接。
  const strippedFence = stripMarkdownFence(trimmed);
  try {
    const parsed = JSON.parse(strippedFence);
    if (typeof parsed === "string") {
      return JSON.parse(parsed);
    }
    return parsed;
  } catch {
    // try decode
  }
  const decoded = decodeEscapedJsonLikeText(strippedFence);
  try {
    return JSON.parse(decoded);
  } catch {
    // pass
  }
  const objStart = decoded.indexOf("{");
  const objEnd = decoded.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) {
    return JSON.parse(decoded.slice(objStart, objEnd + 1));
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

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function dedupeStrings(input: string[]): string[] {
  return Array.from(new Set(input.map((item) => normalizeWhitespace(item)).filter(Boolean)));
}

function asString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input.trim() : undefined;
}

function asBoolean(input: unknown): boolean | undefined {
  return typeof input === "boolean" ? input : undefined;
}

function asNumber(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function asCategory(input: unknown): ItemCategory | undefined {
  if (typeof input !== "string") return undefined;
  return (
    {
      "open-source": "open-source",
      tooling: "tooling",
      agent: "agent",
      research: "research",
      "industry-news": "industry-news",
      tutorial: "tutorial",
      other: "other",
    } as Record<string, ItemCategory>
  )[input];
}

function asRankingDimension(input: unknown): "source" | "freshness" | "keyword" | undefined {
  if (input === "source" || input === "freshness" || input === "keyword") {
    return input;
  }
  return undefined;
}

function asImportance(input: unknown): "high" | "medium" | "low" | undefined {
  if (input === "high" || input === "medium" || input === "low") {
    return input;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
