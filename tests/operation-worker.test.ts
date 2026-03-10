import { describe, expect, it, vi } from "vitest";

import { executeOperationJob } from "../src/daemon/worker.js";
import type { OperationJob } from "../src/daemon/types.js";

function buildJob(input: Partial<OperationJob>): OperationJob {
  return {
    id: input.id ?? 1,
    jobType: input.jobType ?? "run_weekly",
    status: input.status ?? "pending",
    payload: input.payload ?? {},
    retryCount: input.retryCount ?? 0,
    maxRetries: input.maxRetries ?? 0,
    createdAt: input.createdAt ?? "2026-03-09T01:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-03-09T01:00:00.000Z",
  };
}

describe("executeOperationJob", () => {
  it("应按 jobType 路由到对应执行器", async () => {
    const executor = {
      runReport: vi.fn(async () => "run_ok"),
      recheckWeekly: vi.fn(async () => "recheck_ok"),
      runWatchdog: vi.fn(async () => "watchdog_ok"),
      notifyWeeklyReminder: vi.fn(async () => "reminder_ok"),
      queryWeeklyStatus: vi.fn(async () => "status_ok"),
      runGitSync: vi.fn(async () => "git_ok"),
    };

    const result = await executeOperationJob(
      buildJob({
        jobType: "recheck_weekly",
        payload: { reportDate: "2026-03-09" },
      }),
      executor,
    );

    expect(result).toBe("recheck_ok");
    expect(executor.recheckWeekly).toHaveBeenCalledTimes(1);
  });

  it("watchdog_weekly_dry_run 应强制 dryRun=true", async () => {
    const executor = {
      runReport: vi.fn(async () => "run_ok"),
      recheckWeekly: vi.fn(async () => "recheck_ok"),
      runWatchdog: vi.fn(async () => "watchdog_ok"),
      notifyWeeklyReminder: vi.fn(async () => "reminder_ok"),
      queryWeeklyStatus: vi.fn(async () => "status_ok"),
      runGitSync: vi.fn(async () => "git_ok"),
    };

    await executeOperationJob(
      buildJob({
        jobType: "watchdog_weekly_dry_run",
        payload: { dryRun: false },
      }),
      executor,
    );

    expect(executor.runWatchdog).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
      }),
    );
  });

  it("run_weekly 未提供 mock 字段时应默认使用真实数据（mock=false）", async () => {
    const executor = {
      runReport: vi.fn(async () => "run_ok"),
      recheckWeekly: vi.fn(async () => "recheck_ok"),
      runWatchdog: vi.fn(async () => "watchdog_ok"),
      notifyWeeklyReminder: vi.fn(async () => "reminder_ok"),
      queryWeeklyStatus: vi.fn(async () => "status_ok"),
      runGitSync: vi.fn(async () => "git_ok"),
    };

    await executeOperationJob(
      buildJob({
        jobType: "run_weekly",
        payload: {
          mode: "weekly",
          reportDate: "2026-03-09",
        },
      }),
      executor,
    );

    expect(executor.runReport).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "weekly",
        mock: false,
      }),
    );
  });

  it("应在执行前触发进度 hook，并在 hook 抛错时中断执行", async () => {
    const executor = {
      runReport: vi.fn(async () => "run_ok"),
      recheckWeekly: vi.fn(async () => "recheck_ok"),
      runWatchdog: vi.fn(async () => "watchdog_ok"),
      notifyWeeklyReminder: vi.fn(async () => "reminder_ok"),
      queryWeeklyStatus: vi.fn(async () => "status_ok"),
      runGitSync: vi.fn(async () => "git_ok"),
    };
    const onProgress = vi.fn(async () => undefined);

    await executeOperationJob(
      buildJob({
        jobType: "run_daily",
        payload: {
          mode: "daily",
        },
      }),
      executor,
      {
        onProgress,
      },
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "run_report",
      }),
    );

    await expect(
      executeOperationJob(
        buildJob({
          jobType: "recheck_weekly",
          payload: { reportDate: "2026-03-09" },
        }),
        executor,
        {
          ensureNotCancelled: async () => {
            throw new Error("cancelled_by_operator");
          },
        },
      ),
    ).rejects.toThrow("cancelled_by_operator");
    expect(executor.recheckWeekly).toHaveBeenCalledTimes(0);
  });
});
