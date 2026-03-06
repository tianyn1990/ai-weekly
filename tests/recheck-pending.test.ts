import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createEmptyMetrics } from "../src/core/utils.js";
import type { RankedItem, ReportState } from "../src/core/types.js";
import { createInitialState } from "../src/pipeline/nodes.js";
import { recheckPendingWeeklyReport } from "../src/pipeline/recheck.js";
import { FileReviewInstructionStore } from "../src/review/instruction-store.js";

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
              { stage: "outline_review", approved: true, decidedAt: "2026-03-09T02:20:00.000Z" },
              { stage: "final_review", approved: true, decidedAt: "2026-03-09T02:30:00.000Z" },
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

  it("命中 request_revision 时应执行修订并保持 final_review", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-recheck-"));
    const runtimeConfigPath = path.join(tempDir, "runtime-config.json");
    try {
      const instructionDir = path.join(tempDir, "weekly");
      await fs.mkdir(instructionDir, { recursive: true });
      await fs.writeFile(
        path.join(instructionDir, "2026-03-10.json"),
        JSON.stringify(
          {
            mode: "weekly",
            reportDate: "2026-03-10",
            instructions: [
              { stage: "outline_review", action: "approve_outline", decidedAt: "2026-03-10T09:10:00.000Z" },
              {
                stage: "final_review",
                action: "request_revision",
                decidedAt: "2026-03-10T09:20:00.000Z",
                feedback: {
                  candidateAdditions: [
                    {
                      title: "新增 Agent 实战案例",
                      link: "https://example.com/agent-case",
                      category: "agent",
                    },
                  ],
                  sourceToggles: [{ sourceId: "openai-news", enabled: false }],
                  rankingWeightAdjustments: [{ dimension: "keyword", weight: 1.2 }],
                  editorNotes: "补充一条工程实践",
                },
              },
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
        runtimeConfigPath,
        sourceLimit: 2,
        generatedAt: "2026-03-10T09:30:00.000Z",
        reviewStartedAt: "2026-03-10T09:00:00.000Z",
        reportDate: "2026-03-10",
        runId: "test-recheck-revision",
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
      expect(result.reviewStatus).toBe("pending_review");
      expect(result.reviewStage).toBe("final_review");
      expect(result.shouldPublish).toBe(false);
      expect(result.revisionAuditLogs.length).toBe(1);
      expect(result.rankedItems.some((item) => item.title.includes("新增 Agent 实战案例"))).toBe(true);
      const runtimeConfig = JSON.parse(await fs.readFile(runtimeConfigPath, "utf-8"));
      expect(runtimeConfig.sourceToggles["openai-news"]).toBe(false);
      expect(runtimeConfig.rankingWeights.keyword).toBe(1.2);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("命中 reject 时应终止当前 run，超过截止也不得发布", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-recheck-"));
    try {
      const instructionDir = path.join(tempDir, "weekly");
      await fs.mkdir(instructionDir, { recursive: true });
      await fs.writeFile(
        path.join(instructionDir, "2026-03-11.json"),
        JSON.stringify(
          {
            mode: "weekly",
            reportDate: "2026-03-11",
            instructions: [
              { stage: "outline_review", action: "approve_outline", decidedAt: "2026-03-11T09:10:00.000Z" },
              { stage: "final_review", action: "reject", decidedAt: "2026-03-11T09:20:00.000Z", reason: "内容方向不符" },
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
        generatedAt: "2026-03-11T13:00:00.000Z",
        reviewStartedAt: "2026-03-11T09:00:00.000Z",
        reportDate: "2026-03-11",
        runId: "test-recheck-reject",
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
        reviewDeadlineAt: "2026-03-11T12:30:00.000Z",
      };

      const result = await recheckPendingWeeklyReport(pendingState);
      expect(result.reviewStatus).toBe("rejected");
      expect(result.shouldPublish).toBe(false);
      expect(result.publishStatus).toBe("pending");
      expect(result.publishReason).toBe("weekly_rejected_no_publish");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("应支持 request_revision 后再次 approve_final 完成发布", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-recheck-"));
    const runtimeConfigPath = path.join(tempDir, "runtime-config.json");
    try {
      const instructionStore = new FileReviewInstructionStore(tempDir);
      await instructionStore.appendInstruction({
        mode: "weekly",
        reportDate: "2026-03-12",
        stage: "outline_review",
        action: "approve_outline",
        decidedAt: "2026-03-12T09:10:00.000Z",
      });
      await instructionStore.appendInstruction({
        mode: "weekly",
        reportDate: "2026-03-12",
        stage: "final_review",
        action: "request_revision",
        decidedAt: "2026-03-12T09:20:00.000Z",
        feedback: {
          candidateAdditions: [{ title: "补充回流条目", link: "https://example.com/revision-item", category: "agent" }],
        },
      });

      const initial = createInitialState({
        mode: "weekly",
        timezone: "Asia/Shanghai",
        useMock: false,
        sourceConfigPath: "data/sources.yaml",
        runtimeConfigPath,
        sourceLimit: 2,
        generatedAt: "2026-03-12T09:30:00.000Z",
        reviewStartedAt: "2026-03-12T09:00:00.000Z",
        reportDate: "2026-03-12",
        runId: "test-recheck-revision-approve",
        approveOutline: false,
        approveFinal: false,
        reviewInstructionRoot: tempDir,
      });
      const pendingState: ReportState = {
        ...initial,
        rankedItems: [createRankedItem("Agent 工程实践")],
        highlights: [createRankedItem("Agent 工程实践")],
        outlineMarkdown: "### 重点推荐（大纲）\n- Agent 工程实践",
        metrics: createEmptyMetrics(),
        reviewStatus: "pending_review",
        reviewStage: "final_review",
      };

      const revised = await recheckPendingWeeklyReport(pendingState);
      expect(revised.reviewStatus).toBe("pending_review");
      expect(revised.reviewStage).toBe("final_review");
      expect(revised.finalApproved).toBe(false);

      await instructionStore.appendInstruction({
        mode: "weekly",
        reportDate: "2026-03-12",
        stage: "final_review",
        action: "approve_final",
        decidedAt: "2026-03-12T09:40:00.000Z",
      });

      const approved = await recheckPendingWeeklyReport({
        ...revised,
        generatedAt: "2026-03-12T09:45:00.000Z",
      });
      expect(approved.reviewStatus).toBe("approved");
      expect(approved.publishStatus).toBe("published");
      expect(approved.shouldPublish).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
