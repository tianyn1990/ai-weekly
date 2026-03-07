import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DbRuntimeConfigStore, RuntimeConfigVersionConflictError, createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import { SqliteEngine } from "../src/storage/sqlite-engine.js";

describe("DbRuntimeConfigStore", () => {
  it("应支持版本化写入与读取", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-db-runtime-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    try {
      const store = new DbRuntimeConfigStore(new SqliteEngine(dbPath));
      const initial = await store.getCurrent();
      expect(initial.version).toBe(0);

      const nextConfig = createDefaultRuntimeConfig("2026-03-12T09:00:00.000Z");
      nextConfig.topics = ["Agent Workflow"];
      const saved = await store.saveNext({
        config: nextConfig,
        updatedAt: nextConfig.updatedAt,
        expectedVersion: 0,
        updatedBy: "tester",
      });

      expect(saved.version).toBe(1);
      const latest = await store.getCurrent();
      expect(latest.version).toBe(1);
      expect(latest.config.topics).toContain("Agent Workflow");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("版本不匹配时应返回冲突错误", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-db-runtime-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    try {
      const store = new DbRuntimeConfigStore(new SqliteEngine(dbPath));
      const config = createDefaultRuntimeConfig("2026-03-12T09:00:00.000Z");
      await store.saveNext({
        config,
        updatedAt: config.updatedAt,
        expectedVersion: 0,
      });

      await expect(
        store.saveNext({
          config: { ...config, updatedAt: "2026-03-12T09:10:00.000Z" },
          updatedAt: "2026-03-12T09:10:00.000Z",
          expectedVersion: 0,
        }),
      ).rejects.toBeInstanceOf(RuntimeConfigVersionConflictError);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
