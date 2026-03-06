import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createEmptyMetrics } from "../src/core/utils.js";
import type { RankedItem, ReportState } from "../src/core/types.js";
import { createInitialState } from "../src/pipeline/nodes.js";
import { recheckPendingWeeklyReport } from "../src/pipeline/recheck.js";

function createRankedItem(title: string): RankedItem {
  return {
    id: `${title}-id`,
    sourceId: "test-source",
    sourceName: "Test Source",
    title,
    link: "https://example.com/item",
    contentSnippet: "测试摘要",
    publishedAt: "2026-03-09T01:00:00.000Z",
    category: "agent",
    score: 88,
    importance: "high",
    recommendationReason: "测试推荐理由",
  };
}

describe("recheckPendingWeeklyReport", () => {
  it("复检命中持久化终稿通过指令时应发布 approved 版本", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-recheck-"));
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

      const state = createInitialState({
        mode: "weekly",
        timezone: "Asia/Shanghai",
        useMock: false,
        sourceConfigPath: "data/sources.yaml",
        sourceLimit: 2,
        generatedAt: "2026-03-09T02:10:00.000Z",
        reportDate: "2026-03-09",
        runId: "test-recheck-approved",
        approveOutline: false,
        approveFinal: false,
        reviewInstructionRoot: tempDir,
      });

      const pendingState: ReportState = {
        ...state,
        rankedItems: [createRankedItem("Agent 工程实践")],
        highlights: [createRankedItem("Agent 工程实践")],
        outlineMarkdown: "### 重点推荐（大纲）\n- Agent 工程实践",
        metrics: createEmptyMetrics(),
        reviewStatus: "pending_review",
        reviewStage: "final_review",
      };

      const result = await recheckPendingWeeklyReport(pendingState);
      expect(result.reviewStatus).toBe("approved");
      expect(result.publishStatus).toBe("published");
      expect(result.shouldPublish).toBe(true);
      expect(result.publishReason).toBe("weekly_manual_approved");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("复检超过截止时间时应发布 timeout 版本", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-recheck-"));
    try {
      const state = createInitialState({
        mode: "weekly",
        timezone: "Asia/Shanghai",
        useMock: false,
        sourceConfigPath: "data/sources.yaml",
        sourceLimit: 2,
        generatedAt: "2026-03-09T05:00:00.000Z",
        reportDate: "2026-03-09",
        runId: "test-recheck-timeout",
        approveOutline: false,
        approveFinal: false,
        reviewInstructionRoot: tempDir,
      });

      const pendingState: ReportState = {
        ...state,
        rankedItems: [createRankedItem("Agent 工程实践")],
        highlights: [createRankedItem("Agent 工程实践")],
        outlineMarkdown: "### 重点推荐（大纲）\n- Agent 工程实践",
        metrics: createEmptyMetrics(),
        reviewStatus: "pending_review",
        reviewStage: "outline_review",
        reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      };

      const result = await recheckPendingWeeklyReport(pendingState);
      expect(result.reviewStatus).toBe("timeout_published");
      expect(result.publishStatus).toBe("published");
      expect(result.shouldPublish).toBe(true);
      expect(result.publishReason).toBe("weekly_timeout_auto_publish");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
