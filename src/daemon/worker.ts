import { z } from "zod";

import type { OperationJob } from "./types.js";

const runJobPayloadSchema = z.object({
  mode: z.enum(["daily", "weekly"]),
  mock: z.boolean().default(false),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  generatedAt: z.string().datetime().optional(),
});

const recheckPayloadSchema = z.object({
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedAt: z.string().datetime().optional(),
});

const watchdogPayloadSchema = z.object({
  dryRun: z.boolean().default(false),
  generatedAt: z.string().datetime().optional(),
});

const reminderPayloadSchema = z.object({
  generatedAt: z.string().datetime().optional(),
});

const queryStatusPayloadSchema = z.object({
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const gitSyncPayloadSchema = z.object({
  reason: z.string().optional(),
});

export interface OperationJobExecutor {
  runReport(input: z.infer<typeof runJobPayloadSchema>): Promise<string>;
  recheckWeekly(input: z.infer<typeof recheckPayloadSchema>): Promise<string>;
  runWatchdog(input: z.infer<typeof watchdogPayloadSchema>): Promise<string>;
  notifyWeeklyReminder(input: z.infer<typeof reminderPayloadSchema>): Promise<string>;
  queryWeeklyStatus(input: z.infer<typeof queryStatusPayloadSchema>): Promise<string>;
  runGitSync(input: z.infer<typeof gitSyncPayloadSchema>): Promise<string>;
}

export interface OperationJobExecutionHooks {
  // 在关键阶段上报进度，供飞书通知或审计链路消费。
  onProgress?: (input: {
    phase: "operation";
    stage: string;
    detail: string;
  }) => Promise<void>;
  // 协作式中止检查：在阶段边界调用，命中后由上层抛出中止错误并结束任务。
  ensureNotCancelled?: () => Promise<void>;
}

export async function executeOperationJob(
  job: OperationJob,
  executor: OperationJobExecutor,
  hooks: OperationJobExecutionHooks = {},
): Promise<string> {
  const checkpoint = async (stage: string, detail: string) => {
    await hooks.ensureNotCancelled?.();
    await hooks.onProgress?.({ phase: "operation", stage, detail });
    await hooks.ensureNotCancelled?.();
  };

  if (job.jobType === "run_daily" || job.jobType === "run_weekly") {
    const parsed = runJobPayloadSchema.parse(job.payload);
    await checkpoint("run_report", `开始执行 ${parsed.mode} 报告生成`);
    return executor.runReport(parsed);
  }

  if (job.jobType === "recheck_weekly") {
    await checkpoint("recheck_weekly", "开始执行周报复检");
    return executor.recheckWeekly(recheckPayloadSchema.parse(job.payload));
  }

  if (job.jobType === "watchdog_weekly" || job.jobType === "watchdog_weekly_dry_run") {
    const parsed = watchdogPayloadSchema.parse({
      ...job.payload,
      dryRun: job.jobType === "watchdog_weekly_dry_run" ? true : job.payload.dryRun,
    });
    await checkpoint("watchdog_weekly", `开始执行 watchdog（dryRun=${parsed.dryRun}）`);
    return executor.runWatchdog(parsed);
  }

  if (job.jobType === "notify_weekly_reminder") {
    await checkpoint("notify_weekly_reminder", "开始执行审核提醒");
    return executor.notifyWeeklyReminder(reminderPayloadSchema.parse(job.payload));
  }

  if (job.jobType === "query_weekly_status") {
    await checkpoint("query_weekly_status", "开始查询本期状态");
    return executor.queryWeeklyStatus(queryStatusPayloadSchema.parse(job.payload));
  }

  await checkpoint("git_sync", "开始执行 Git 同步");
  return executor.runGitSync(gitSyncPayloadSchema.parse(job.payload));
}
