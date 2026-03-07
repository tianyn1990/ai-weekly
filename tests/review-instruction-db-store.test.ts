import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DbReviewInstructionStore } from "../src/review/instruction-store.js";
import { SqliteEngine } from "../src/storage/sqlite-engine.js";

describe("DbReviewInstructionStore", () => {
  it("应按 decidedAt + id 取最新有效指令", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-db-instruction-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    try {
      const store = new DbReviewInstructionStore(new SqliteEngine(dbPath));
      await store.appendInstruction({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "final_review",
        action: "approve_final",
        decidedAt: "2026-03-09T02:00:00.000Z",
        source: "api",
        operator: "user_a",
      });
      await store.appendInstruction({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "final_review",
        action: "reject",
        decidedAt: "2026-03-09T02:00:00.000Z",
        source: "api",
        operator: "user_b",
      });

      const latest = await store.getLatestInstruction({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "final_review",
      });
      expect(latest?.action).toBe("reject");
      const latestDecision = await store.getLatestDecision({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "final_review",
      });
      expect(latestDecision).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("应支持 reviewStartedAt 边界过滤", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-db-instruction-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    try {
      const store = new DbReviewInstructionStore(new SqliteEngine(dbPath));
      await store.appendInstruction({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "final_review",
        action: "reject",
        decidedAt: "2026-03-09T01:00:00.000Z",
        source: "api",
      });
      await store.appendInstruction({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "final_review",
        action: "approve_final",
        decidedAt: "2026-03-09T03:00:00.000Z",
        source: "api",
      });

      const latestAfterBoundary = await store.getLatestInstruction({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "final_review",
        decidedAfterOrAt: "2026-03-09T02:00:00.000Z",
      });
      expect(latestAfterBoundary?.action).toBe("approve_final");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("应支持按 messageId + stage + action 判重查询", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-db-instruction-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    try {
      const store = new DbReviewInstructionStore(new SqliteEngine(dbPath));
      await store.appendInstruction({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "final_review",
        action: "approve_final",
        decidedAt: "2026-03-09T03:00:00.000Z",
        source: "feishu_callback",
        messageId: "msg-001",
      });

      const duplicated = await store.findDuplicateInstruction({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "final_review",
        action: "approve_final",
        messageId: "msg-001",
      });
      expect(duplicated?.messageId).toBe("msg-001");
      expect(duplicated?.action).toBe("approve_final");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
