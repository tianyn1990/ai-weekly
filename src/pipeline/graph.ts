import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import type { ReportState } from "../core/types.js";
import {
  buildReportNode,
  classifyItemsNode,
  collectItemsNode,
  dedupeItemsNode,
  normalizeItemsNode,
  rankItemsNode,
} from "./nodes.js";

const ReportStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  mode: Annotation<ReportState["mode"]>(),
  timezone: Annotation<string>(),
  generatedAt: Annotation<string>(),
  useMock: Annotation<boolean>(),
  sourceConfigPath: Annotation<string>(),
  sourceLimit: Annotation<number>(),
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
  reportMarkdown: Annotation<string>({
    value: (_left, right) => right,
    default: () => "",
  }),
  metrics: Annotation<ReportState["metrics"]>(),
  warnings: Annotation<ReportState["warnings"]>({
    value: (_left, right) => right,
    default: () => [],
  }),
});

export type CompiledReportGraph = ReturnType<typeof buildReportGraph>;

export function buildReportGraph() {
  return new StateGraph(ReportStateAnnotation)
    .addNode("collect_items", collectItemsNode)
    .addNode("normalize_items", normalizeItemsNode)
    .addNode("dedupe_items", dedupeItemsNode)
    .addNode("classify_items", classifyItemsNode)
    .addNode("rank_items", rankItemsNode)
    .addNode("build_report", buildReportNode)
    .addEdge(START, "collect_items")
    .addEdge("collect_items", "normalize_items")
    .addEdge("normalize_items", "dedupe_items")
    .addEdge("dedupe_items", "classify_items")
    .addEdge("classify_items", "rank_items")
    .addEdge("rank_items", "build_report")
    .addEdge("build_report", END)
    .compile();
}
