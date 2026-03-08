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

export async function executeOperationJob(job: OperationJob, executor: OperationJobExecutor): Promise<string> {
  if (job.jobType === "run_daily" || job.jobType === "run_weekly") {
    const parsed = runJobPayloadSchema.parse(job.payload);
    return executor.runReport(parsed);
  }

  if (job.jobType === "recheck_weekly") {
    return executor.recheckWeekly(recheckPayloadSchema.parse(job.payload));
  }

  if (job.jobType === "watchdog_weekly" || job.jobType === "watchdog_weekly_dry_run") {
    const parsed = watchdogPayloadSchema.parse({
      ...job.payload,
      dryRun: job.jobType === "watchdog_weekly_dry_run" ? true : job.payload.dryRun,
    });
    return executor.runWatchdog(parsed);
  }

  if (job.jobType === "notify_weekly_reminder") {
    return executor.notifyWeeklyReminder(reminderPayloadSchema.parse(job.payload));
  }

  if (job.jobType === "query_weekly_status") {
    return executor.queryWeeklyStatus(queryStatusPayloadSchema.parse(job.payload));
  }

  return executor.runGitSync(gitSyncPayloadSchema.parse(job.payload));
}
