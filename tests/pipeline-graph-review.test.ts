import path from "node:path";

import { describe, expect, it } from "vitest";

import { createInitialState } from "../src/pipeline/nodes.js";
import { buildReportGraph } from "../src/pipeline/graph.js";

const sourceConfigPath = path.join(process.cwd(), "data/sources.yaml");

describe("pipeline graph review flow", () => {
  it("周报在审核窗口内未通过审核时应进入 pending_review", async () => {
    const graph = buildReportGraph();
    const state = createInitialState({
      mode: "weekly",
      timezone: "Asia/Shanghai",
      useMock: true,
      sourceConfigPath,
      sourceLimit: 2,
      generatedAt: "2026-03-09T01:00:00.000Z",
      runId: "test-weekly-pending",
      approveOutline: false,
      approveFinal: false,
    });

    const result = await graph.invoke(state as any);

    expect(result.reviewStatus).toBe("pending_review");
    expect(result.reviewStage).toBe("outline_review");
    expect(result.shouldPublish).toBe(false);
    expect(result.publishStatus).toBe("pending");
  });

  it("周报审核全部通过时应发布 approved 版本", async () => {
    const graph = buildReportGraph();
    const state = createInitialState({
      mode: "weekly",
      timezone: "Asia/Shanghai",
      useMock: true,
      sourceConfigPath,
      sourceLimit: 2,
      generatedAt: "2026-03-09T02:00:00.000Z",
      runId: "test-weekly-approved",
      approveOutline: true,
      approveFinal: true,
    });

    const result = await graph.invoke(state as any);

    expect(result.reviewStatus).toBe("approved");
    expect(result.shouldPublish).toBe(true);
    expect(result.publishStatus).toBe("published");
  });

  it("周报超过截止时间时应自动发布 timeout 版本", async () => {
    const graph = buildReportGraph();
    const state = createInitialState({
      mode: "weekly",
      timezone: "Asia/Shanghai",
      useMock: true,
      sourceConfigPath,
      sourceLimit: 2,
      generatedAt: "2026-03-09T05:00:00.000Z",
      runId: "test-weekly-timeout",
      approveOutline: false,
      approveFinal: false,
    });

    const result = await graph.invoke(state as any);

    expect(result.reviewStatus).toBe("timeout_published");
    expect(result.shouldPublish).toBe(true);
    expect(result.publishReason).toBe("weekly_timeout_auto_publish");
  });
});
