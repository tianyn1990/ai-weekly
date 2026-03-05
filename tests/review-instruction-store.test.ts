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
});

