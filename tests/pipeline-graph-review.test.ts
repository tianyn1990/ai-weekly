import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createInitialState } from "../src/pipeline/nodes.js";
import { buildReportGraph } from "../src/pipeline/graph.js";

const sourceConfigPath = path.join(process.cwd(), "data/sources.yaml");

describe("pipeline graph review flow", () => {
  it("周报在审核窗口内未通过审核时应进入 pending_review", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-review-"));
    try {
      const graph = buildReportGraph();
      const state = createInitialState({
        mode: "weekly",
        timezone: "Asia/Shanghai",
        useMock: true,
        sourceConfigPath,
        sourceLimit: 2,
        generatedAt: "2026-03-09T01:00:00.000Z",
        reportDate: "2026-03-09",
        runId: "test-weekly-pending",
        approveOutline: false,
        approveFinal: false,
        reviewInstructionRoot: tempDir,
      });

      const result = await graph.invoke(state as any);

      expect(result.reviewStatus).toBe("pending_review");
      expect(result.reviewStage).toBe("outline_review");
      expect(result.shouldPublish).toBe(false);
      expect(result.publishStatus).toBe("pending");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("周报审核全部通过时应发布 approved 版本", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-review-"));
    try {
      const graph = buildReportGraph();
      const state = createInitialState({
        mode: "weekly",
        timezone: "Asia/Shanghai",
        useMock: true,
        sourceConfigPath,
        sourceLimit: 2,
        generatedAt: "2026-03-09T02:00:00.000Z",
        reportDate: "2026-03-09",
        runId: "test-weekly-approved",
        approveOutline: true,
        approveFinal: true,
        reviewInstructionRoot: tempDir,
      });

      const result = await graph.invoke(state as any);

      expect(result.reviewStatus).toBe("approved");
      expect(result.shouldPublish).toBe(true);
      expect(result.publishStatus).toBe("published");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("周报超过截止时间时应自动发布 timeout 版本", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-review-"));
    try {
      const graph = buildReportGraph();
      const state = createInitialState({
        mode: "weekly",
        timezone: "Asia/Shanghai",
        useMock: true,
        sourceConfigPath,
        sourceLimit: 2,
        generatedAt: "2026-03-09T05:00:00.000Z",
        reportDate: "2026-03-09",
        runId: "test-weekly-timeout",
        approveOutline: false,
        approveFinal: false,
        reviewInstructionRoot: tempDir,
      });

      const result = await graph.invoke(state as any);

      expect(result.reviewStatus).toBe("timeout_published");
      expect(result.shouldPublish).toBe(true);
      expect(result.publishReason).toBe("weekly_timeout_auto_publish");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("存在持久化审核指令时应优先使用指令而非 CLI 参数", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-review-"));
    try {
      const instructionDir = path.join(tempDir, "weekly");
      await fs.mkdir(instructionDir, { recursive: true });
      await fs.writeFile(
        path.join(instructionDir, "2026-03-09.json"),
        JSON.stringify(
          {
            mode: "weekly",
            reportDate: "2026-03-09",
            instructions: [
              { stage: "outline_review", approved: true, decidedAt: "2026-03-09T01:00:00.000Z" },
              { stage: "final_review", approved: true, decidedAt: "2026-03-09T02:00:00.000Z" },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const graph = buildReportGraph();
      const state = createInitialState({
        mode: "weekly",
        timezone: "Asia/Shanghai",
        useMock: true,
        sourceConfigPath,
        sourceLimit: 2,
        generatedAt: "2026-03-09T02:30:00.000Z",
        reportDate: "2026-03-09",
        runId: "test-weekly-persisted-instruction",
        approveOutline: false,
        approveFinal: false,
        reviewInstructionRoot: tempDir,
      });

      const result = await graph.invoke(state as any);

      expect(result.outlineApproved).toBe(true);
      expect(result.finalApproved).toBe(true);
      expect(result.reviewStatus).toBe("approved");
      expect(result.publishStatus).toBe("published");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
