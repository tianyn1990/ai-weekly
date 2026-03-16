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

  it("应支持对 running 任务记录中止请求并在后续落为 cancelled", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-opjob-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    try {
      const store = new DbOperationJobStore(new SqliteEngine(dbPath));
      const created = await store.enqueue({
        jobType: "run_weekly",
        payload: { reportDate: "2026-03-10" },
        dedupeKey: "manual_op:run_weekly:2026-03-10",
      });
      const picked = await store.pickNextPending();
      expect(picked?.id).toBe(created.jobId);

      const cancel = await store.requestCancelCurrent({
        operator: "ou_test",
        reason: "manual_abort",
      });
      expect(cancel.found).toBe(true);
      expect(cancel.status).toBe("running");
      expect(cancel.jobId).toBe(created.jobId);
      expect(cancel.alreadyRequested).toBe(false);

      const secondCancel = await store.requestCancelCurrent({
        operator: "ou_test",
        reason: "manual_abort",
      });
      expect(secondCancel.found).toBe(true);
      expect(secondCancel.alreadyRequested).toBe(true);
      expect(secondCancel.status).toBe("cancelled");

      const afterSecond = await store.getById(created.jobId);
      expect(afterSecond?.status).toBe("cancelled");

      const requested = await store.isCancelRequested(created.jobId);
      expect(requested).toBe(true);

      // 中止请求后应立即释放 dedupe 占位，允许后续同动作重新入队。
      const reEnqueue = await store.enqueue({
        jobType: "run_weekly",
        payload: { reportDate: "2026-03-10" },
        dedupeKey: "manual_op:run_weekly:2026-03-10",
      });
      expect(reEnqueue.created).toBe(true);

      const changed = await store.markCancelled(created.jobId, "cancelled_by_operator");
      expect(changed).toBe(false);
      const final = await store.getById(created.jobId);
      expect(final?.status).toBe("cancelled");
      expect(final?.lastError).toContain("cancel_requested_by:");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("应优先取消 pending 任务并直接标记 cancelled", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-opjob-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    try {
      const store = new DbOperationJobStore(new SqliteEngine(dbPath));
      const created = await store.enqueue({
        jobType: "notify_weekly_reminder",
        payload: { generatedAt: "2026-03-10T01:00:00.000Z" },
        dedupeKey: "manual_op:notify_weekly_reminder:2026-03-10",
      });

      const cancel = await store.requestCancelCurrent({
        operator: "ou_test",
      });
      expect(cancel.found).toBe(true);
      expect(cancel.status).toBe("cancelled");
      expect(cancel.jobId).toBe(created.jobId);

      const final = await store.getById(created.jobId);
      expect(final?.status).toBe("cancelled");
      // pending 被中止后也应释放 dedupe 占位，支持同动作立刻重提。
      const reEnqueue = await store.enqueue({
        jobType: "notify_weekly_reminder",
        payload: { generatedAt: "2026-03-10T01:00:00.000Z" },
        dedupeKey: "manual_op:notify_weekly_reminder:2026-03-10",
      });
      expect(reEnqueue.created).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("应支持按指定 jobId 精确中止（running -> 请求/强制中止）", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-opjob-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    try {
      const store = new DbOperationJobStore(new SqliteEngine(dbPath));
      const first = await store.enqueue({
        jobType: "run_weekly",
        payload: { reportDate: "2026-03-11" },
        dedupeKey: "manual_op:run_weekly:2026-03-11",
      });
      const second = await store.enqueue({
        jobType: "run_daily",
        payload: { reportDate: "2026-03-11" },
        dedupeKey: "manual_op:run_daily:2026-03-11",
      });
      const picked = await store.pickNextPending();
      expect(picked?.id).toBe(first.jobId);

      const cancelById = await store.requestCancelByJobId({
        jobId: first.jobId,
        operator: "ou_test",
      });
      expect(cancelById.found).toBe(true);
      expect(cancelById.status).toBe("running");
      expect(cancelById.jobId).toBe(first.jobId);
      expect(cancelById.reportDate).toBe("2026-03-11");

      const forceCancelById = await store.requestCancelByJobId({
        jobId: first.jobId,
        operator: "ou_test",
      });
      expect(forceCancelById.found).toBe(true);
      expect(forceCancelById.status).toBe("cancelled");
      expect(forceCancelById.alreadyRequested).toBe(true);

      const afterFirst = await store.getById(first.jobId);
      expect(afterFirst?.status).toBe("cancelled");
      const untouchedSecond = await store.getById(second.jobId);
      expect(untouchedSecond?.status).toBe("pending");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("按不存在 jobId 中止应返回 found=false", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-opjob-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    try {
      const store = new DbOperationJobStore(new SqliteEngine(dbPath));
      const result = await store.requestCancelByJobId({
        jobId: 99999,
        operator: "ou_test",
      });
      expect(result.found).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("listActive 仅返回 pending/running 任务", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-opjob-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    try {
      const store = new DbOperationJobStore(new SqliteEngine(dbPath));
      const a = await store.enqueue({
        jobType: "run_weekly",
        payload: { reportDate: "2026-03-11" },
      });
      const b = await store.enqueue({
        jobType: "run_daily",
        payload: { reportDate: "2026-03-11" },
      });
      const picked = await store.pickNextPending();
      expect(picked?.id).toBe(a.jobId);
      await store.markSuccess(b.jobId);

      const active = await store.listActive(20);
      expect(active.some((item) => item.id === a.jobId && item.status === "running")).toBe(true);
      expect(active.some((item) => item.id === b.jobId)).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("应记录并回读运行态进度快照（用于 query_status 直读）", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-opjob-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    try {
      const store = new DbOperationJobStore(new SqliteEngine(dbPath));
      const created = await store.enqueue({
        jobType: "run_weekly",
        payload: { reportDate: "2026-03-11" },
        dedupeKey: "manual_op:run_weekly:2026-03-11",
      });
      await store.pickNextPending();

      const changed = await store.updateRuntimeProgress(created.jobId, {
        phase: "pipeline",
        stage: "llm_summarize",
        nodeKey: "llm_summarize",
        nodeState: "end",
        detail: "完成节点 llm_summarize",
        updatedAt: "2026-03-11T03:00:00.000Z",
        elapsedMs: 4200,
        ok: true,
      });
      expect(changed).toBe(true);

      const loaded = await store.getById(created.jobId);
      expect(loaded?.runtimeProgress).toMatchObject({
        phase: "pipeline",
        stage: "llm_summarize",
        nodeKey: "llm_summarize",
        nodeState: "end",
      });
      expect(loaded?.runtimeProgressEventCount).toBe(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("findRecentByDedupeKey 应返回窗口内最近任务", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-opjob-"));
    const dbPath = path.join(tempDir, "app.sqlite");
    try {
      const store = new DbOperationJobStore(new SqliteEngine(dbPath));
      await store.enqueue({
        jobType: "run_weekly",
        payload: { reportDate: "2026-03-11" },
        dedupeKey: "manual_restart:run_weekly:2026-03-11",
      });
      const second = await store.enqueue({
        jobType: "run_weekly",
        payload: { reportDate: "2026-03-11" },
        dedupeKey: "manual_restart:run_weekly:2026-03-11:alt",
      });

      const recent = await store.findRecentByDedupeKey("manual_restart:run_weekly:2026-03-11");
      expect(recent?.jobType).toBe("run_weekly");
      expect(recent?.payload.reportDate).toBe("2026-03-11");
      expect(recent?.id).not.toBe(second.jobId);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
