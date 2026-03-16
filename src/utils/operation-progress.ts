import { z } from "zod";

// 子进程通过 stdout 上报进度时的固定前缀；父进程仅解析该前缀行，避免误读普通日志。
export const OPERATION_PROGRESS_STDOUT_PREFIX = "[op-progress]";

export type OperationProgressNotifyLevel = "off" | "milestone" | "verbose";

export type PipelineProgressNodeState = "start" | "end";

export interface PipelineProgressEvent {
  phase: "pipeline";
  nodeKey: string;
  nodeState: PipelineProgressNodeState;
  detail: string;
  createdAt: string;
  elapsedMs?: number;
  ok?: boolean;
}

const pipelineProgressEventSchema = z.object({
  phase: z.literal("pipeline"),
  nodeKey: z.string().min(1),
  nodeState: z.enum(["start", "end"]),
  detail: z.string(),
  createdAt: z.string().datetime(),
  elapsedMs: z.number().int().nonnegative().optional(),
  ok: z.boolean().optional(),
});

// milestone 默认只覆盖“用户最关心且耗时明显”的节点，避免群内高频刷屏。
export const OPERATION_PROGRESS_MILESTONE_NODES = new Set<string>([
  "collect_items",
  "llm_classify_score",
  "rank_items",
  "publish_or_wait",
  "llm_summarize",
  "build_report",
]);

export function emitPipelineProgressEvent(input: {
  nodeKey: string;
  nodeState: PipelineProgressNodeState;
  detail: string;
  elapsedMs?: number;
  ok?: boolean;
}) {
  if (process.env.OP_PROGRESS_PIPE_STDOUT !== "true") {
    return;
  }

  const payload: PipelineProgressEvent = {
    phase: "pipeline",
    nodeKey: input.nodeKey,
    nodeState: input.nodeState,
    detail: input.detail,
    createdAt: new Date().toISOString(),
    ...(typeof input.elapsedMs === "number" ? { elapsedMs: input.elapsedMs } : {}),
    ...(typeof input.ok === "boolean" ? { ok: input.ok } : {}),
  };
  console.log(`${OPERATION_PROGRESS_STDOUT_PREFIX}${JSON.stringify(payload)}`);
}

export function parsePipelineProgressLine(line: string): PipelineProgressEvent | null {
  if (!line.startsWith(OPERATION_PROGRESS_STDOUT_PREFIX)) {
    return null;
  }
  const jsonText = line.slice(OPERATION_PROGRESS_STDOUT_PREFIX.length).trim();
  if (!jsonText) {
    return null;
  }
  try {
    const parsed = JSON.parse(jsonText);
    return pipelineProgressEventSchema.parse(parsed);
  } catch {
    return null;
  }
}
