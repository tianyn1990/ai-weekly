import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DbOperationJobStore } from "../src/daemon/operation-job-store.js";
import { SqliteEngine } from "../src/storage/sqlite-engine.js";

describe("DbOperationJobStore", () => {
  it("应支持按 dedupeKey 去重入队", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-opjob-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    try {
      const store = new DbOperationJobStore(new SqliteEngine(dbPath));
      const first = await store.enqueue({
        jobType: "recheck_weekly",
        payload: { reportDate: "2026-03-09" },
        dedupeKey: "recheck:2026-03-09",
      });
      const second = await store.enqueue({
        jobType: "recheck_weekly",
        payload: { reportDate: "2026-03-09" },
        dedupeKey: "recheck:2026-03-09",
      });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.jobId).toBe(first.jobId);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("已成功任务在去重窗口内应拦截重复入队，窗口外允许重试", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-opjob-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    try {
      const engine = new SqliteEngine(dbPath);
      const store = new DbOperationJobStore(engine);
      const first = await store.enqueue({
        jobType: "run_weekly",
        payload: { reportDate: "2026-03-09" },
        dedupeKey: "manual_op:run_weekly:2026-03-09",
      });
      await store.markSuccess(first.jobId);

      const second = await store.enqueue({
        jobType: "run_weekly",
        payload: { reportDate: "2026-03-09" },
        dedupeKey: "manual_op:run_weekly:2026-03-09",
      });
      expect(second.created).toBe(false);
      expect(second.jobId).toBe(first.jobId);

      // 人工把旧任务时间回拨到窗口外，验证后续同动作允许再次执行（用于补跑场景）。
      await engine.write((ctx) => {
        ctx.run(
          "UPDATE operation_jobs SET created_at = $createdAt, updated_at = $createdAt WHERE id = $id;",
          {
            $id: first.jobId,
            $createdAt: "2000-01-01T00:00:00.000Z",
          },
        );
      });

      const third = await store.enqueue({
        jobType: "run_weekly",
        payload: { reportDate: "2026-03-09" },
        dedupeKey: "manual_op:run_weekly:2026-03-09",
      });
      expect(third.created).toBe(true);
      expect(third.jobId).not.toBe(first.jobId);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("应支持取出 pending 任务并标记 success", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-opjob-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    try {
      const store = new DbOperationJobStore(new SqliteEngine(dbPath));
      const created = await store.enqueue({
        jobType: "notify_weekly_reminder",
        payload: { generatedAt: "2026-03-09T03:30:00.000Z" },
      });

      const picked = await store.pickNextPending();
      expect(picked?.id).toBe(created.jobId);
      expect(picked?.status).toBe("running");

      await store.markSuccess(created.jobId);
      const final = await store.getById(created.jobId);
      expect(final?.status).toBe("success");
      expect(final?.finishedAt).toBeTruthy();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("失败后应按 maxRetries 回队，超限后 failed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-opjob-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    try {
      const store = new DbOperationJobStore(new SqliteEngine(dbPath));
      const created = await store.enqueue({
        jobType: "watchdog_weekly",
        payload: { dryRun: false },
        maxRetries: 1,
      });

      const picked1 = await store.pickNextPending();
      expect(picked1?.id).toBe(created.jobId);
      const firstFailed = await store.markFailed(created.jobId, "network_error");
      expect(firstFailed.requeued).toBe(true);
      expect(firstFailed.retryCount).toBe(1);

      const picked2 = await store.pickNextPending();
      expect(picked2?.id).toBe(created.jobId);
      const secondFailed = await store.markFailed(created.jobId, "network_error_again");
      expect(secondFailed.requeued).toBe(false);
      expect(secondFailed.retryCount).toBe(2);

      const final = await store.getById(created.jobId);
      expect(final?.status).toBe("failed");
      expect(final?.lastError).toContain("network_error_again");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
