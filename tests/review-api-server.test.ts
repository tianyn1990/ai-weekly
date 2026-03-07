import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DbAuditStore } from "../src/audit/audit-store.js";
import { createDefaultRuntimeConfig, createRuntimeConfigStore } from "../src/config/runtime-config.js";
import { startReviewApiServer } from "../src/review/api-server.js";
import { createReviewInstructionStore } from "../src/review/instruction-store.js";
import { SqliteEngine } from "../src/storage/sqlite-engine.js";

describe("review api server", () => {
  it("应支持审核动作写入与最新动作查询", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-review-api-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    const outputRoot = path.join(tempDir, "review");
    const authToken = "token-123";

    const reviewStore = createReviewInstructionStore({
      backend: "db",
      dbPath,
      fileRoot: path.join(tempDir, "instructions"),
      fallbackToFile: true,
    });
    const runtimeStore = createRuntimeConfigStore({
      backend: "db",
      dbPath,
      filePath: path.join(tempDir, "runtime-config.json"),
      fallbackToFile: true,
    });
    const auditStore = new DbAuditStore(new SqliteEngine(dbPath));

    const server = await startReviewApiServer({
      host: "127.0.0.1",
      port: 0,
      authToken,
      outputRoot,
      reviewStore,
      runtimeStore,
      auditStore,
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const postRes = await fetch(`${baseUrl}/api/review-actions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          mode: "weekly",
          reportDate: "2026-03-09",
          stage: "final_review",
          action: "approve_final",
          decidedAt: "2026-03-09T02:10:00.000Z",
          source: "api",
          operator: "tester",
        }),
      });
      expect(postRes.status).toBe(200);

      const latestRes = await fetch(
        `${baseUrl}/api/review-actions/latest?mode=weekly&reportDate=2026-03-09&stage=final_review`,
        {
          headers: {
            authorization: `Bearer ${authToken}`,
          },
        },
      );
      expect(latestRes.status).toBe(200);
      const latestPayload = (await latestRes.json()) as {
        ok: boolean;
        instruction: { action: string };
      };
      expect(latestPayload.ok).toBe(true);
      expect(latestPayload.instruction.action).toBe("approve_final");
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("应支持 runtime config patch 与版本冲突检测", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-review-api-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    const outputRoot = path.join(tempDir, "review");
    const authToken = "token-123";

    const runtimeStore = createRuntimeConfigStore({
      backend: "db",
      dbPath,
      filePath: path.join(tempDir, "runtime-config.json"),
      fallbackToFile: true,
    });
    const initial = createDefaultRuntimeConfig("2026-03-12T09:00:00.000Z");
    await runtimeStore.saveNext({
      config: initial,
      updatedAt: initial.updatedAt,
      expectedVersion: 0,
      updatedBy: "seed",
    });

    const reviewStore = createReviewInstructionStore({
      backend: "db",
      dbPath,
      fileRoot: path.join(tempDir, "instructions"),
      fallbackToFile: true,
    });
    const auditStore = new DbAuditStore(new SqliteEngine(dbPath));
    const server = await startReviewApiServer({
      host: "127.0.0.1",
      port: 0,
      authToken,
      outputRoot,
      reviewStore,
      runtimeStore,
      auditStore,
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const patchOk = await fetch(`${baseUrl}/api/runtime-config`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          expectedVersion: 1,
          patch: {
            topics: ["LangGraph"],
          },
          operator: "tester",
        }),
      });
      expect(patchOk.status).toBe(200);

      const patchConflict = await fetch(`${baseUrl}/api/runtime-config`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          expectedVersion: 1,
          patch: {
            topics: ["conflict"],
          },
          operator: "tester",
        }),
      });
      expect(patchConflict.status).toBe(409);
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
