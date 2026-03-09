import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import type { ReportState } from "../core/types.js";
import {
  buildOutlineNode,
  buildReportNode,
  classifyItemsNode,
  collectItemsNode,
  dedupeItemsNode,
  llmSummarizeNode,
  normalizeItemsNode,
  publishOrWaitNode,
  rankItemsNode,
  reviewFinalNode,
  reviewOutlineNode,
} from "./nodes.js";

const ReportStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  mode: Annotation<ReportState["mode"]>(),
  timezone: Annotation<string>(),
  generatedAt: Annotation<string>(),
  reviewStartedAt: Annotation<string>(),
  reportDate: Annotation<string>(),
  useMock: Annotation<boolean>(),
  sourceConfigPath: Annotation<string>(),
  runtimeConfigPath: Annotation<string>(),
  storageBackend: Annotation<ReportState["storageBackend"]>(),
  storageDbPath: Annotation<string>(),
  storageFallbackToFile: Annotation<boolean>(),
  sourceLimit: Annotation<number>(),
  llmSummaryEnabled: Annotation<boolean>(),
  llmSummaryProvider: Annotation<ReportState["llmSummaryProvider"]>(),
  llmSummaryMinimaxApiKey: Annotation<string | undefined>(),
  llmSummaryMinimaxModel: Annotation<string>(),
  llmSummaryTimeoutMs: Annotation<number>(),
  llmSummaryMaxItems: Annotation<number>(),
  llmSummaryMaxConcurrency: Annotation<number>(),
  llmGlobalMaxConcurrency: Annotation<number>(),
  llmRankFusionWeight: Annotation<number>(),
  llmAssistMinConfidence: Annotation<number>(),
  llmSummaryPromptVersion: Annotation<string>(),
  llmFallbackAlertEnabled: Annotation<boolean>(),
  reviewInstructionRoot: Annotation<string>(),
  approveOutline: Annotation<boolean>(),
  approveFinal: Annotation<boolean>(),
  // 数组字段默认采用 replace reducer，确保每个 node 输出可预测、便于调试。
  rawItems: Annotation<ReportState["rawItems"]>({
    value: (_left, right) => right,
    default: () => [],
  }),
  items: Annotation<ReportState["items"]>({
    value: (_left, right) => right,
    default: () => [],
  }),
  rankedItems: Annotation<ReportState["rankedItems"]>({
    value: (_left, right) => right,
    default: () => [],
  }),
  highlights: Annotation<ReportState["highlights"]>({
    value: (_left, right) => right,
    default: () => [],
  }),
  outlineMarkdown: Annotation<string>({
    value: (_left, right) => right,
    default: () => "",
  }),
  reportMarkdown: Annotation<string>({
    value: (_left, right) => right,
    default: () => "",
  }),
  outlineApproved: Annotation<boolean>(),
  finalApproved: Annotation<boolean>(),
  rejected: Annotation<boolean>(),
  reviewStatus: Annotation<ReportState["reviewStatus"]>(),
  reviewStage: Annotation<ReportState["reviewStage"]>(),
  reviewDeadlineAt: Annotation<ReportState["reviewDeadlineAt"]>(),
  reviewReason: Annotation<string>(),
  publishStatus: Annotation<ReportState["publishStatus"]>(),
  shouldPublish: Annotation<boolean>(),
  publishedAt: Annotation<ReportState["publishedAt"]>(),
  publishReason: Annotation<string>(),
  metrics: Annotation<ReportState["metrics"]>(),
  revisionAuditLogs: Annotation<ReportState["revisionAuditLogs"]>({
    value: (_left, right) => right,
    default: () => [],
  }),
  itemSummaries: Annotation<ReportState["itemSummaries"]>({
    value: (_left, right) => right,
    default: () => [],
  }),
  quickDigest: Annotation<ReportState["quickDigest"]>({
    value: (_left, right) => right,
    default: () => [],
  }),
  leadSummary: Annotation<string>({
    value: (_left, right) => right,
    default: () => "",
  }),
  summaryInputHash: Annotation<string>({
    value: (_left, right) => right,
    default: () => "",
  }),
  llmSummaryMeta: Annotation<ReportState["llmSummaryMeta"]>(),
  warnings: Annotation<ReportState["warnings"]>({
    value: (_left, right) => right,
    default: () => [],
  }),
});

export type CompiledReportGraph = ReturnType<typeof buildReportGraph>;

export function buildReportGraph() {
  // M2 进入“可审核+可自动发布”的流程：先审大纲，再审终稿，最后统一发布决策。
  return new StateGraph(ReportStateAnnotation)
    .addNode("collect_items", collectItemsNode)
    .addNode("normalize_items", normalizeItemsNode)
    .addNode("dedupe_items", dedupeItemsNode)
    .addNode("classify_items", classifyItemsNode)
    .addNode("rank_items", rankItemsNode)
    .addNode("build_outline", buildOutlineNode)
    .addNode("review_outline", reviewOutlineNode)
    .addNode("review_final", reviewFinalNode)
    .addNode("publish_or_wait", publishOrWaitNode)
    .addNode("llm_summarize", llmSummarizeNode)
    .addNode("build_report", buildReportNode)
    .addEdge(START, "collect_items")
    .addEdge("collect_items", "normalize_items")
    .addEdge("normalize_items", "dedupe_items")
    .addEdge("dedupe_items", "classify_items")
    .addEdge("classify_items", "rank_items")
    .addEdge("rank_items", "build_outline")
    .addEdge("build_outline", "review_outline")
    .addEdge("review_outline", "review_final")
    .addEdge("review_final", "publish_or_wait")
    .addEdge("publish_or_wait", "llm_summarize")
    .addEdge("llm_summarize", "build_report")
    .addEdge("build_report", END)
    .compile();
}
