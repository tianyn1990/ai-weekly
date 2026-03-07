import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DbRuntimeConfigStore, createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import { DbReviewInstructionStore } from "../src/review/instruction-store.js";
import { migrateFileToDb } from "../src/storage/migrate-file-to-db.js";
import { SqliteEngine } from "../src/storage/sqlite-engine.js";

describe("migrateFileToDb", () => {
  it("应将文件中的审核动作与 runtime 配置导入 DB", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-migrate-"));
    const reviewInstructionRoot = path.join(tempDir, "review-instructions");
    const runtimeConfigPath = path.join(tempDir, "runtime-config.json");
    const dbPath = path.join(tempDir, "app.sqlite");

    try {
      await fs.mkdir(path.join(reviewInstructionRoot, "weekly"), { recursive: true });
      await fs.writeFile(
        path.join(reviewInstructionRoot, "weekly", "2026-03-09.json"),
        JSON.stringify(
          {
            mode: "weekly",
            reportDate: "2026-03-09",
            instructions: [
              {
                stage: "outline_review",
                action: "approve_outline",
                decidedAt: "2026-03-09T02:10:00.000Z",
                source: "feishu_callback",
                operator: "tester",
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const runtime = createDefaultRuntimeConfig("2026-03-09T02:00:00.000Z");
      runtime.topics = ["Agent"];
      await fs.writeFile(runtimeConfigPath, JSON.stringify(runtime, null, 2), "utf-8");

      const result = await migrateFileToDb({
        instructionRoot: reviewInstructionRoot,
        runtimeConfigPath,
        dbPath,
      });

      expect(result.instruction.inserted).toBe(1);
      expect(result.instruction.failed).toBe(0);
      expect(result.runtimeConfig.insertedVersion).toBeGreaterThan(0);

      const reviewStore = new DbReviewInstructionStore(new SqliteEngine(dbPath));
      const latest = await reviewStore.getLatestInstruction({
        mode: "weekly",
        reportDate: "2026-03-09",
        stage: "outline_review",
      });
      expect(latest?.action).toBe("approve_outline");

      const runtimeStore = new DbRuntimeConfigStore(new SqliteEngine(dbPath));
      const latestRuntime = await runtimeStore.getCurrent();
      expect(latestRuntime.config.topics).toContain("Agent");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
