import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FileReviewInstructionStore } from "../src/review/instruction-store.js";

describe("FileReviewInstructionStore", () => {
  it("应按 decidedAt 取同阶段最新审核指令", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-instruction-"));
    try {
      const weeklyDir = path.join(tempDir, "weekly");
      await fs.mkdir(weeklyDir, { recursive: true });
      await fs.writeFile(
        path.join(weeklyDir, "2026-03-09.json"),
        JSON.stringify(
          {
            mode: "weekly",
            reportDate: "2026-03-09",
            instructions: [
              { stage: "outline_review", approved: false, decidedAt: "2026-03-09T01:00:00.000Z" },
              { stage: "outline_review", approved: true, decidedAt: "2026-03-09T02:00:00.000Z" },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const store = new FileReviewInstructionStore(tempDir);
      const decision = await store.getLatestDecision({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "outline_review",
      });

      expect(decision).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("未命中阶段或文件不存在时应返回 null", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-instruction-"));
    try {
      const store = new FileReviewInstructionStore(tempDir);
      const missingFile = await store.getLatestDecision({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "outline_review",
      });
      expect(missingFile).toBeNull();

      const weeklyDir = path.join(tempDir, "weekly");
      await fs.mkdir(weeklyDir, { recursive: true });
      await fs.writeFile(
        path.join(weeklyDir, "2026-03-09.json"),
        JSON.stringify(
          {
            mode: "weekly",
            reportDate: "2026-03-09",
            instructions: [{ stage: "outline_review", approved: true, decidedAt: "2026-03-09T01:00:00.000Z" }],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const missingStage = await store.getLatestDecision({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "final_review",
      });
      expect(missingStage).toBeNull();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("应支持写入 action 指令并被读取为最新决策", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-instruction-"));
    try {
      const store = new FileReviewInstructionStore(tempDir);
      await store.appendInstruction({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "outline_review",
        action: "approve_outline",
        source: "feishu_callback",
        decidedAt: "2026-03-09T01:00:00.000Z",
        operator: "user_a",
      });
      await store.appendInstruction({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "outline_review",
        action: "reject",
        source: "feishu_callback",
        decidedAt: "2026-03-09T02:00:00.000Z",
        operator: "user_b",
      });

      const latestDecision = await store.getLatestDecision({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "outline_review",
      });
      expect(latestDecision).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("应支持按 decidedAfterOrAt 过滤旧指令，避免历史 reject 影响新 run", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-instruction-"));
    try {
      const store = new FileReviewInstructionStore(tempDir);
      await store.appendInstruction({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "final_review",
        action: "reject",
        source: "feishu_callback",
        decidedAt: "2026-03-09T09:30:00.000Z",
        operator: "user_old",
      });
      await store.appendInstruction({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "final_review",
        action: "approve_final",
        source: "feishu_callback",
        decidedAt: "2026-03-09T13:10:00.000Z",
        operator: "user_new",
      });

      const oldRun = await store.getLatestInstruction({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "final_review",
        decidedAfterOrAt: "2026-03-09T09:00:00.000Z",
      });
      expect(oldRun?.action).toBe("approve_final");

      const newRunOnly = await store.getLatestInstruction({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "final_review",
        decidedAfterOrAt: "2026-03-09T12:30:00.000Z",
      });
      expect(newRunOnly?.action).toBe("approve_final");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("应保留并读取结构化 feedback 字段", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-instruction-"));
    try {
      const store = new FileReviewInstructionStore(tempDir);
      await store.appendInstruction({
        mode: "weekly",
        reportDate: "2026-03-12",
        stage: "final_review",
        action: "request_revision",
        source: "feishu_callback",
        decidedAt: "2026-03-12T09:20:00.000Z",
        feedback: {
          newTopics: ["Agent Workflow"],
          sourceToggles: [{ sourceId: "openai-news", enabled: false }],
        },
      });

      const latest = await store.getLatestInstruction({
        mode: "weekly",
        reportDate: "2026-03-12",
        stage: "final_review",
      });
      expect(latest?.action).toBe("request_revision");
      expect(latest?.feedback?.newTopics).toEqual(["Agent Workflow"]);
      expect(latest?.feedback?.sourceToggles?.[0]).toEqual({ sourceId: "openai-news", enabled: false });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
