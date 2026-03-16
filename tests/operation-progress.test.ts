import { describe, expect, it, vi } from "vitest";

import {
  OPERATION_PROGRESS_STDOUT_PREFIX,
  emitPipelineProgressEvent,
  parsePipelineProgressLine,
} from "../src/utils/operation-progress.js";

describe("operation-progress utils", () => {
  it("应解析合法的 pipeline 进度行", () => {
    const line = `${OPERATION_PROGRESS_STDOUT_PREFIX}${JSON.stringify({
      phase: "pipeline",
      nodeKey: "collect_items",
      nodeState: "start",
      detail: "进入 collect_items",
      createdAt: "2026-03-11T02:03:04.000Z",
    })}`;

    const parsed = parsePipelineProgressLine(line);
    expect(parsed).toMatchObject({
      phase: "pipeline",
      nodeKey: "collect_items",
      nodeState: "start",
      detail: "进入 collect_items",
    });
  });

  it("遇到非法行应返回 null", () => {
    expect(parsePipelineProgressLine("normal log line")).toBeNull();
    expect(parsePipelineProgressLine(`${OPERATION_PROGRESS_STDOUT_PREFIX}{invalid`)).toBeNull();
  });

  it("仅在开关启用时输出结构化进度行", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const prev = process.env.OP_PROGRESS_PIPE_STDOUT;
    try {
      process.env.OP_PROGRESS_PIPE_STDOUT = "false";
      emitPipelineProgressEvent({
        nodeKey: "rank_items",
        nodeState: "start",
        detail: "进入节点 rank_items",
      });
      expect(logSpy).not.toHaveBeenCalled();

      process.env.OP_PROGRESS_PIPE_STDOUT = "true";
      emitPipelineProgressEvent({
        nodeKey: "rank_items",
        nodeState: "end",
        detail: "完成节点 rank_items",
        elapsedMs: 1200,
        ok: true,
      });
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(String(logSpy.mock.calls[0]?.[0])).toContain(OPERATION_PROGRESS_STDOUT_PREFIX);
    } finally {
      process.env.OP_PROGRESS_PIPE_STDOUT = prev;
      logSpy.mockRestore();
    }
  });
});
