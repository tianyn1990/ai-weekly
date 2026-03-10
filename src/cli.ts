#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import dayjs from "dayjs";

import type { ReviewArtifact } from "./core/review-artifact.js";
import { reviewArtifactSchema } from "./core/review-artifact.js";
import type { ReportMode, ReportState } from "./core/types.js";
import { buildReportGraph } from "./pipeline/graph.js";
import { createInitialState, loadEnabledSources } from "./pipeline/nodes.js";
import { recheckPendingWeeklyReport } from "./pipeline/recheck.js";
import type { WatchdogCandidate } from "./pipeline/watchdog.js";
import { runPendingWeeklyWatchdog } from "./pipeline/watchdog.js";
import { startReviewApiServer } from "./review/api-server.js";
import { FeishuNotifier, loadFeishuConfigFromEnv, startFeishuReviewCallbackServer } from "./review/feishu.js";
import type { FeishuCallbackAuditEvent, FeishuOperationActionPayload } from "./review/feishu.js";
import { createReviewInstructionStore } from "./review/instruction-store.js";
import { isWeeklyReminderWindowReached, shouldSendWeeklyReminderForArtifact } from "./review/reminder-policy.js";
import { DbAuditStore } from "./audit/audit-store.js";
import { createRuntimeConfigStore } from "./config/runtime-config.js";
import { DbOperationJobStore } from "./daemon/operation-job-store.js";
import { buildManualOperationDedupeKey } from "./daemon/operation-dedupe.js";
import { FileScheduleMarkerStore } from "./daemon/schedule-marker-store.js";
import { computeDueScheduledJobs } from "./daemon/scheduler.js";
import { executeOperationJob } from "./daemon/worker.js";
import type { OperationJobType } from "./daemon/types.js";
import { autoSyncToGit } from "./git/auto-sync.js";
import { SqliteEngine } from "./storage/sqlite-engine.js";
import { migrateFileToDb } from "./storage/migrate-file-to-db.js";
import { acquireFileLock } from "./utils/file-lock.js";
import { loadProjectEnv } from "./utils/env-loader.js";
import { nowInTimezoneIso } from "./utils/time.js";

const CLI_SUBPROCESS_BASE_ARGS = ["--import", "tsx"];
const HARD_CANCEL_POLL_MS = 400;
const HARD_CANCEL_SIGKILL_GRACE_MS = 4_000;

interface CliArgs {
  command: "run";
  mode: ReportMode;
  mock: boolean;
  sourceConfigPath: string;
  runtimeConfigPath: string;
  storageBackend: "file" | "db";
  storageDbPath: string;
  storageFallbackToFile: boolean;
  sourceLimit: number;
  llmSummaryEnabled: boolean;
  llmClassifyScoreEnabled: boolean;
  llmClassifyScoreBatchSize: number;
  llmClassifyScoreTimeoutMs: number;
  llmClassifyScoreMaxConcurrency: number;
  llmClassifyScoreMinConfidence: number;
  llmClassifyScorePromptVersion: string;
  llmSummaryProvider: "minimax";
  llmSummaryMinimaxApiKey?: string;
  llmSummaryMinimaxModel: string;
  llmSummaryTimeoutMs: number;
  llmSummaryMaxItems: number;
  llmSummaryMaxConcurrency: number;
  llmGlobalMaxConcurrency: number;
  llmRankFusionWeight: number;
  llmAssistMinConfidence: number;
  llmSummaryPromptVersion: string;
  llmFallbackAlertEnabled: boolean;
  revisionAgentEnabled: boolean;
  revisionAgentMaxSteps: number;
  revisionAgentMaxWallClockMs: number;
  revisionAgentMaxLlmCalls: number;
  revisionAgentMaxToolErrors: number;
  revisionAgentPlannerTimeoutMs: number;
  timezone: string;
  outputRoot: string;
  publishRoot: string;
  reviewInstructionRoot: string;
  approveOutline: boolean;
  approveFinal: boolean;
  recheckPending: boolean;
  watchPendingWeekly: boolean;
  dryRun: boolean;
  watchLockFile: string;
  watchForceUnlock: boolean;
  watchMaxRetries: number;
  watchRetryDelayMs: number;
  watchSummaryRoot: string;
  serveFeishuCallback: boolean;
  serveReviewApi: boolean;
  migrateFileToDb: boolean;
  notifyReviewReminder: boolean;
  daemon: boolean;
  daemonSchedulerIntervalMs: number;
  daemonWorkerPollMs: number;
  daemonMarkerRoot: string;
  autoGitSync: boolean;
  gitSyncPush: boolean;
  gitSyncRemote: string;
  gitSyncBranch?: string;
  gitSyncIncludePaths: string[];
  gitSyncHttpProxy?: string;
  gitSyncHttpsProxy?: string;
  gitSyncNoProxy?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuReviewChatId?: string;
  reportPublicBaseUrl?: string;
  feishuNotificationRoot: string;
  feishuDebugVerbose: boolean;
  feishuCallbackHost: string;
  feishuCallbackPort: number;
  feishuCallbackPath: string;
  feishuCallbackAuthToken?: string;
  feishuSigningSecret?: string;
  reviewApiHost: string;
  reviewApiPort: number;
  reviewApiAuthToken?: string;
  notificationRoot: string;
  reportDate?: string;
  generatedAt?: string;
}

async function main() {
  // CLI 启动时强制加载项目 `.env.local`，避免全局 shell 变量污染本仓库配置。
  await loadProjectEnv({ override: true });
  const args = parseArgs(process.argv.slice(2));

  if (args.command !== "run") {
    throw new Error("仅支持 run 命令。示例: pnpm run:weekly:mock");
  }

  if (args.daemon) {
    await runDaemon(args);
    return;
  }

  if (args.recheckPending) {
    await runRecheckPending(args);
    return;
  }

  if (args.migrateFileToDb) {
    await runMigrateFileToDb(args);
    return;
  }

  if (args.serveReviewApi) {
    await runServeReviewApi(args);
    return;
  }

  if (args.serveFeishuCallback) {
    await runServeFeishuCallback(args);
    return;
  }

  if (args.notifyReviewReminder) {
    await runNotifyReviewReminder(args);
    return;
  }

  if (args.watchPendingWeekly) {
    await runWatchPendingWeekly(args);
    return;
  }

  await runPipeline(args);
}

async function runPipeline(args: CliArgs) {
  const generatedAt = args.generatedAt ?? nowInTimezoneIso(args.timezone);
  const reportDate = args.reportDate ?? generatedAt.slice(0, 10);
  const runId = `${args.mode}-${Date.now()}`;

  const enabledSources = await loadEnabledSources({
    sourceConfigPath: args.sourceConfigPath,
    runtimeConfigPath: args.runtimeConfigPath,
    storageBackend: args.storageBackend,
    storageDbPath: args.storageDbPath,
    storageFallbackToFile: args.storageFallbackToFile,
  });
  console.log(`[run] mode=${args.mode}, mock=${args.mock}, sources=${enabledSources.length}`);

  // CLI 只负责 orchestration：准备初始状态、执行 graph、落盘产物。
  const graph = buildReportGraph();
  const initialState = createInitialState({
    mode: args.mode,
    timezone: args.timezone,
    useMock: args.mock,
    sourceConfigPath: args.sourceConfigPath,
    runtimeConfigPath: args.runtimeConfigPath,
    storageBackend: args.storageBackend,
    storageDbPath: args.storageDbPath,
    storageFallbackToFile: args.storageFallbackToFile,
    sourceLimit: args.sourceLimit,
    llmSummaryEnabled: args.llmSummaryEnabled,
    llmClassifyScoreEnabled: args.llmClassifyScoreEnabled,
    llmClassifyScoreBatchSize: args.llmClassifyScoreBatchSize,
    llmClassifyScoreTimeoutMs: args.llmClassifyScoreTimeoutMs,
    llmClassifyScoreMaxConcurrency: args.llmClassifyScoreMaxConcurrency,
    llmClassifyScoreMinConfidence: args.llmClassifyScoreMinConfidence,
    llmClassifyScorePromptVersion: args.llmClassifyScorePromptVersion,
    llmSummaryProvider: args.llmSummaryProvider,
    llmSummaryMinimaxApiKey: args.llmSummaryMinimaxApiKey,
    llmSummaryMinimaxModel: args.llmSummaryMinimaxModel,
    llmSummaryTimeoutMs: args.llmSummaryTimeoutMs,
    llmSummaryMaxItems: args.llmSummaryMaxItems,
    llmSummaryMaxConcurrency: args.llmSummaryMaxConcurrency,
    llmGlobalMaxConcurrency: args.llmGlobalMaxConcurrency,
    llmRankFusionWeight: args.llmRankFusionWeight,
    llmAssistMinConfidence: args.llmAssistMinConfidence,
    llmSummaryPromptVersion: args.llmSummaryPromptVersion,
    llmFallbackAlertEnabled: args.llmFallbackAlertEnabled,
    revisionAgentEnabled: args.revisionAgentEnabled,
    revisionAgentMaxSteps: args.revisionAgentMaxSteps,
    revisionAgentMaxWallClockMs: args.revisionAgentMaxWallClockMs,
    revisionAgentMaxLlmCalls: args.revisionAgentMaxLlmCalls,
    revisionAgentMaxToolErrors: args.revisionAgentMaxToolErrors,
    revisionAgentPlannerTimeoutMs: args.revisionAgentPlannerTimeoutMs,
    generatedAt,
    reviewStartedAt: generatedAt,
    reportDate,
    runId,
    approveOutline: args.approveOutline,
    approveFinal: args.approveFinal,
    reviewInstructionRoot: args.reviewInstructionRoot,
  });

  const result = (await graph.invoke(initialState as any)) as ReportState;
  await persistOutputs(result, args, "run");
  printRunResult("done", result);
}

async function runRecheckPending(args: CliArgs) {
  if (args.mode !== "weekly") {
    throw new Error("--recheck-pending 仅支持 weekly 模式");
  }

  const generatedAt = args.generatedAt ?? nowInTimezoneIso(args.timezone);
  const reportDate = args.reportDate ?? generatedAt.slice(0, 10);
  const runId = `recheck-${args.mode}-${Date.now()}`;
  console.log(`[recheck] mode=${args.mode}, reportDate=${reportDate}, instructionRoot=${args.reviewInstructionRoot}`);

  const artifact = await loadReviewArtifact(args.outputRoot, args.mode, reportDate);
  if (!artifact.snapshot) {
    throw new Error(`待复检报告缺少 snapshot（${reportDate}），请先用新版 run 流程重新生成该日期周报。`);
  }

  const recheckState = buildRecheckStateFromArtifact({
    args,
    artifact,
    reportDate,
    generatedAt,
    runId,
  });

  const result = await recheckPendingWeeklyReport(recheckState);
  await persistOutputs(result, args, "recheck");
  printRunResult("recheck", result);
}

async function runWatchPendingWeekly(args: CliArgs) {
  if (args.mode !== "weekly") {
    throw new Error("--watch-pending-weekly 仅支持 weekly 模式");
  }

  const generatedAt = args.generatedAt ?? nowInTimezoneIso(args.timezone);
  const lock = await tryAcquireWatchdogLock(args.watchLockFile, args.watchForceUnlock);
  if (!lock) {
    console.log(`[watch-skip] lock already held: ${args.watchLockFile}`);
    return;
  }

  console.log(
    `[watch] mode=weekly, dryRun=${args.dryRun}, retries=${args.watchMaxRetries}, outputRoot=${args.outputRoot}, instructionRoot=${args.reviewInstructionRoot}`,
  );

  try {
    const loaded = await loadWatchdogCandidates(args);
    const summary = await runPendingWeeklyWatchdog({
      candidates: loaded.candidates,
      dryRun: args.dryRun,
      maxRetries: args.watchMaxRetries,
      retryDelayMs: args.watchRetryDelayMs,
      onRetry: ({ reportDate, attempt, maxRetries, error }) => {
        console.log(
          `[watch-retry] date=${reportDate}, attempt=${attempt}/${maxRetries + 1}, reason=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
      runRecheck: async (candidate) => {
        const runId = `watch-recheck-${candidate.reportDate}-${Date.now()}`;
        const recheckState = buildRecheckStateFromArtifact({
          args,
          artifact: candidate.artifact,
          reportDate: candidate.reportDate,
          generatedAt,
          runId,
        });
        return recheckPendingWeeklyReport(recheckState);
      },
      persistResult: async (result) => {
        await persistOutputs(result, args, "watchdog");
      },
    });
    summary.failed += loaded.precheckFailures.length;
    summary.items = [...loaded.precheckFailures, ...summary.items];

    const summaryPath = await persistWatchdogSummary(args, generatedAt, summary);
    console.log(`[watch-summary-file] ${summaryPath}`);
    console.log(
      `[watch-summary] processed=${summary.processed}, published=${summary.published}, skipped=${summary.skipped}, failed=${summary.failed}`,
    );
    for (const item of summary.items) {
      console.log(
        `[watch-item] date=${item.reportDate}, status=${item.status}, attempts=${item.attempts}, reason=${item.reason}`,
      );
    }

    if (summary.failed > 0) {
      console.log(`[alert] watchdog detected failed items: ${summary.failed}`);
    }
  } finally {
    await lock.release();
  }
}

async function runDaemon(args: CliArgs) {
  if (args.storageBackend !== "db") {
    throw new Error("--daemon 仅支持 --storage-backend=db，确保任务队列可持久化");
  }

  const engine = new SqliteEngine(args.storageDbPath);
  const jobStore = new DbOperationJobStore(engine);
  const markerStore = new FileScheduleMarkerStore(args.daemonMarkerRoot);
  const notifier = createFeishuNotifier(args);
  const callbackAuditLogger = createFeishuCallbackAuditLogger(args);

  const callbackServer = await startFeishuReviewCallbackServer({
    host: args.feishuCallbackHost,
    port: args.feishuCallbackPort,
    path: args.feishuCallbackPath,
    authToken: args.feishuCallbackAuthToken,
    signingSecret: args.feishuSigningSecret,
    store: createReviewInstructionStore({
      backend: args.storageBackend,
      dbPath: args.storageDbPath,
      fileRoot: args.reviewInstructionRoot,
      fallbackToFile: args.storageFallbackToFile,
    }),
    notifier,
    auditLogger: callbackAuditLogger,
    statusEchoProvider: async ({ reportDate }) => await loadStatusEchoFromArtifact(args.outputRoot, reportDate),
    onReviewAccepted: async ({ instruction }) => {
      const dedupeKey = instruction.traceId
        ? `auto_recheck:${instruction.traceId}`
        : `auto_recheck:${instruction.reportDate}:${instruction.action ?? "unknown"}:${instruction.decidedAt}`;
      await jobStore.enqueue({
        jobType: "recheck_weekly",
        payload: {
          reportDate: instruction.reportDate,
          generatedAt: new Date().toISOString(),
        },
        dedupeKey,
        createdBy: instruction.operator,
        source: "feishu_callback_auto",
        traceId: instruction.traceId,
        maxRetries: 1,
      });
    },
    operationHandler: async (payload) =>
      await handleFeishuOperationAction({
        args,
        notifier,
        jobStore,
        payload,
        enqueueMessage: "已受理，任务已入队执行。",
      }),
    mentionHandler: async (payload) => {
      const reportDate = dayjs().tz(args.timezone).format("YYYY-MM-DD");
      const sent = await notifier.notifyOperationControlCard({
        chatId: payload.chatId,
        reportDate,
      });
      return {
        handled: sent,
        message: sent ? `已发送主动触发面板（${reportDate}）。` : "主动触发面板发送失败，请检查应用配置。",
      };
    },
  });

  console.log(
    `[daemon] started callback=http://${args.feishuCallbackHost}:${callbackServer.port}${args.feishuCallbackPath}, schedulerIntervalMs=${args.daemonSchedulerIntervalMs}, workerPollMs=${args.daemonWorkerPollMs}`,
  );

  let schedulerRunning = false;
  let workerRunning = false;

  const runSchedulerTick = async () => {
    if (schedulerRunning) {
      return;
    }
    schedulerRunning = true;
    try {
      const markers = await markerStore.listMarkerKeys();
      const nowIso = nowInTimezoneIso(args.timezone);
      const due = computeDueScheduledJobs({
        nowIso,
        timezoneName: args.timezone,
        alreadyTriggered: markers,
      });

      for (const candidate of due) {
        const enqueue = await jobStore.enqueue(candidate.job);
        await markerStore.mark(candidate.markerKey, {
          created: enqueue.created,
          jobId: enqueue.jobId,
          nowIso,
        });
        console.log(`[daemon-scheduler] marker=${candidate.markerKey}, created=${enqueue.created}, jobId=${enqueue.jobId}`);
      }
    } finally {
      schedulerRunning = false;
    }
  };

  const runWorkerTick = async () => {
    if (workerRunning) {
      return;
    }
    workerRunning = true;
    try {
      await processOneOperationJob(args, jobStore, notifier);
    } finally {
      workerRunning = false;
    }
  };

  // 启动后先执行一次补偿扫描，覆盖 daemon 重启或机器休眠错过窗口的场景。
  await runSchedulerTick();
  await runWorkerTick();

  const schedulerTimer = setInterval(() => {
    runSchedulerTick().catch((error) => {
      console.log(`[daemon-scheduler-warning] ${error instanceof Error ? error.message : String(error)}`);
    });
  }, Math.max(2_000, args.daemonSchedulerIntervalMs));

  const workerTimer = setInterval(() => {
    runWorkerTick().catch((error) => {
      console.log(`[daemon-worker-warning] ${error instanceof Error ? error.message : String(error)}`);
    });
  }, Math.max(500, args.daemonWorkerPollMs));

  await new Promise<void>((resolve) => {
    const close = () => resolve();
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });

  clearInterval(schedulerTimer);
  clearInterval(workerTimer);
  await callbackServer.close();
}

async function runServeFeishuCallback(args: CliArgs) {
  const store = createReviewInstructionStore({
    backend: args.storageBackend,
    dbPath: args.storageDbPath,
    fileRoot: args.reviewInstructionRoot,
    fallbackToFile: args.storageFallbackToFile,
  });
  const notifier = createFeishuNotifier(args);
  const callbackAuditLogger = createFeishuCallbackAuditLogger(args);
  const operationJobStore = args.storageBackend === "db" ? new DbOperationJobStore(new SqliteEngine(args.storageDbPath)) : null;
  const server = await startFeishuReviewCallbackServer({
    host: args.feishuCallbackHost,
    port: args.feishuCallbackPort,
    path: args.feishuCallbackPath,
    authToken: args.feishuCallbackAuthToken,
    signingSecret: args.feishuSigningSecret,
    store,
    notifier,
    auditLogger: callbackAuditLogger,
    // 点击动作后优先从最新产物回显当前状态，减少“动作已收但状态未知”的协作摩擦。
    statusEchoProvider: async ({ reportDate }) => await loadStatusEchoFromArtifact(args.outputRoot, reportDate),
    onReviewAccepted: async ({ instruction }) => {
      if (!operationJobStore) {
        return;
      }
      const dedupeKey = instruction.traceId
        ? `auto_recheck:${instruction.traceId}`
        : `auto_recheck:${instruction.reportDate}:${instruction.action ?? "unknown"}:${instruction.decidedAt}`;
      await operationJobStore.enqueue({
        jobType: "recheck_weekly",
        payload: {
          reportDate: instruction.reportDate,
          generatedAt: new Date().toISOString(),
        },
        dedupeKey,
        createdBy: instruction.operator,
        source: "feishu_callback_auto",
        traceId: instruction.traceId,
        maxRetries: 1,
      });
    },
    operationHandler: async (payload) => {
      if (!operationJobStore) {
        return {
          accepted: false,
          message: "当前存储模式不支持主动触发队列，请切换到 DB 模式。",
        };
      }
      return await handleFeishuOperationAction({
        args,
        notifier,
        jobStore: operationJobStore,
        payload,
        enqueueMessage: "已受理，任务已入队执行（请启动 daemon worker 消费）。",
      });
    },
    mentionHandler: async (payload) => {
      const reportDate = dayjs().tz(args.timezone).format("YYYY-MM-DD");
      const sent = await notifier.notifyOperationControlCard({
        chatId: payload.chatId,
        reportDate,
      });
      return {
        handled: sent,
        message: sent ? `已发送主动触发面板（${reportDate}）。` : "主动触发面板发送失败，请检查应用配置。",
      };
    },
  });

  console.log(
    `[feishu-callback] listening on http://${args.feishuCallbackHost}:${server.port}${args.feishuCallbackPath} (local, 2B)`,
  );
  console.log(
    `[feishu-callback] notifier enabled=${notifier.isEnabled()}, chatId=${args.feishuReviewChatId ? "set" : "missing"}`,
  );
  console.log("[feishu-callback] use tunnel URL in Feishu config and keep this process alive.");

  await new Promise<void>((resolve) => {
    const close = () => resolve();
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
  await server.close();
}

async function runServeReviewApi(args: CliArgs) {
  const reviewStore = createReviewInstructionStore({
    backend: args.storageBackend,
    dbPath: args.storageDbPath,
    fileRoot: args.reviewInstructionRoot,
    fallbackToFile: args.storageFallbackToFile,
  });
  const runtimeStore = createRuntimeConfigStore({
    backend: args.storageBackend,
    dbPath: args.storageDbPath,
    filePath: args.runtimeConfigPath,
    fallbackToFile: args.storageFallbackToFile,
  });
  const auditStore = new DbAuditStore(new SqliteEngine(args.storageDbPath));
  const operationJobStore = args.storageBackend === "db" ? new DbOperationJobStore(new SqliteEngine(args.storageDbPath)) : undefined;

  const server = await startReviewApiServer({
    host: args.reviewApiHost,
    port: args.reviewApiPort,
    authToken: args.reviewApiAuthToken,
    outputRoot: args.outputRoot,
    reviewStore,
    runtimeStore,
    auditStore,
    operationJobStore,
  });

  console.log(`[review-api] listening on http://${args.reviewApiHost}:${server.port}`);
  await new Promise<void>((resolve) => {
    const close = () => resolve();
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
  await server.close();
}

async function runMigrateFileToDb(args: CliArgs) {
  if (args.storageBackend !== "db") {
    throw new Error("--migrate-file-to-db 仅支持在 --storage-backend=db 下执行");
  }

  const summary = await migrateFileToDb({
    instructionRoot: args.reviewInstructionRoot,
    runtimeConfigPath: args.runtimeConfigPath,
    dbPath: args.storageDbPath,
  });

  console.log(
    `[migrate] instructions inserted=${summary.instruction.inserted}, skipped=${summary.instruction.skipped}, failed=${summary.instruction.failed}`,
  );
  console.log(`[migrate] runtime-config insertedVersion=${summary.runtimeConfig.insertedVersion}`);
}

async function runNotifyReviewReminder(args: CliArgs) {
  const notifier = createFeishuNotifier(args);
  if (!notifier.isEnabled()) {
    console.log("[feishu-reminder-skip] 飞书通知通道未配置（需要 FEISHU_APP_ID/FEISHU_APP_SECRET/REVIEW_CHAT_ID）");
    return;
  }

  const generatedAt = args.generatedAt ?? nowInTimezoneIso(args.timezone);
  if (!isWeeklyReminderWindowReached(generatedAt, args.timezone)) {
    console.log(`[feishu-reminder-skip] 当前时间未到提醒窗口（需要周一 11:30 后），now=${generatedAt}`);
    return;
  }

  const loaded = await loadWatchdogCandidates(args);
  let sent = 0;
  let skipped = 0;
  for (const candidate of loaded.candidates) {
    if (!shouldSendWeeklyReminderForArtifact(candidate.artifact, generatedAt)) {
      skipped += 1;
      continue;
    }
    const markerPath = path.join(args.notificationRoot, "reminders", "weekly", `${candidate.reportDate}.json`);
    if (await fileExists(markerPath)) {
      skipped += 1;
      continue;
    }

    const sentOk = await notifier.notifyReviewReminder({
      runId: candidate.artifact.runId,
      reportDate: candidate.reportDate,
      reviewStage: candidate.artifact.reviewStage === "none" ? "final_review" : candidate.artifact.reviewStage,
      reviewDeadlineAt: candidate.artifact.reviewDeadlineAt,
      reviewMarkdownPath: path.join(args.outputRoot, "weekly", `${candidate.reportDate}.md`),
    });
    if (!sentOk) {
      skipped += 1;
      continue;
    }

    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, JSON.stringify({ reportDate: candidate.reportDate, sentAt: generatedAt }, null, 2), "utf-8");
    sent += 1;
    console.log(`[feishu-reminder] sent reportDate=${candidate.reportDate}`);
  }

  console.log(`[feishu-reminder-summary] sent=${sent}, skipped=${skipped}, invalid=${loaded.precheckFailures.length}`);
}

async function processOneOperationJob(args: CliArgs, jobStore: DbOperationJobStore, notifier: FeishuNotifier) {
  const job = await jobStore.pickNextPending();
  if (!job) {
    return;
  }

  const ensureNotCancelled = async () => {
    const requested = await jobStore.isCancelRequested(job.id);
    if (requested) {
      throw new OperationCancelledError("cancel_requested_by_operator");
    }
  };

  if (job.source === "feishu_manual") {
    await notifyOperationStageBestEffort(notifier, {
      operator: job.createdBy,
      operation: job.jobType,
      result: "started",
      jobId: job.id,
      detail: "任务开始执行。",
    });
  }

  try {
    await ensureNotCancelled();
    const detail = await executeOperationJob(job, {
      runReport: async (payload) => {
        await runQueuedCliSubprocess({
          args,
          jobStore,
          jobId: job.id,
          cliArgs: buildRunReportSubprocessArgs(args, payload),
        });
        return `${payload.mode} run 已完成（reportDate=${payload.reportDate ?? "auto"}）`;
      },
      recheckWeekly: async (payload) => {
        await runQueuedCliSubprocess({
          args,
          jobStore,
          jobId: job.id,
          cliArgs: buildRecheckSubprocessArgs(args, payload),
        });
        return `recheck 已完成（reportDate=${payload.reportDate}）`;
      },
      runWatchdog: async (payload) => {
        await runQueuedCliSubprocess({
          args,
          jobStore,
          jobId: job.id,
          cliArgs: buildWatchdogSubprocessArgs(args, payload),
        });
        return `watchdog 已完成（dryRun=${payload.dryRun}）`;
      },
      notifyWeeklyReminder: async (payload) => {
        await runQueuedCliSubprocess({
          args,
          jobStore,
          jobId: job.id,
          cliArgs: buildReminderSubprocessArgs(args, payload),
        });
        return "提醒任务已执行";
      },
      queryWeeklyStatus: async (payload) => {
        const artifact = await loadReviewArtifact(args.outputRoot, "weekly", payload.reportDate);
        return `status: review=${artifact.reviewStatus}, stage=${artifact.reviewStage}, publish=${artifact.publishStatus}`;
      },
      runGitSync: async () => {
        const result = await runAutoGitSync(args, `operation_job:${job.id}`);
        if (!result.changed) {
          return "git 同步跳过（无变更）";
        }
        return `git 同步完成（committed=${result.committed}, pushed=${result.pushed}, sha=${result.commitSha ?? "none"}）`;
      },
    }, {
      ensureNotCancelled,
      onProgress: async ({ detail: progressDetail }) => {
        if (job.source !== "feishu_manual") {
          return;
        }
        await notifyOperationStageBestEffort(notifier, {
          operator: job.createdBy,
          operation: job.jobType,
          result: "progress",
          detail: progressDetail,
          jobId: job.id,
        });
      },
    });

    // 任务执行完成后再次检查取消标记，避免“执行完成后被覆盖成 success”。
    if (await jobStore.isCancelRequested(job.id)) {
      await jobStore.markCancelled(job.id, "cancelled_by_operator");
      if (job.source === "feishu_manual") {
        await notifyOperationStageBestEffort(notifier, {
          operator: job.createdBy,
          operation: job.jobType,
          result: "cancelled",
          detail: "已按操作员请求中止。",
          jobId: job.id,
        });
      }
      return;
    }

    await jobStore.markSuccess(job.id);
    if (job.source === "feishu_manual") {
      await notifier
        .notifyOperationResult({
          operator: job.createdBy,
          operation: job.jobType,
          result: "success",
          detail,
          jobId: job.id,
        })
        .catch((error) => {
          console.log(`[daemon-notify-warning] ${error instanceof Error ? error.message : String(error)}`);
        });
    }
  } catch (error) {
    if (error instanceof OperationCancelledError || (await jobStore.isCancelRequested(job.id))) {
      await jobStore.markCancelled(job.id, "cancelled_by_operator");
      if (job.source === "feishu_manual") {
        await notifyOperationStageBestEffort(notifier, {
          operator: job.createdBy,
          operation: job.jobType,
          result: "cancelled",
          detail: "已按操作员请求中止。",
          jobId: job.id,
        });
      }
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const failed = await jobStore.markFailed(job.id, message);
    if (!failed.requeued && job.source === "feishu_manual") {
      const classified = classifyOperationFailure(message);
      await notifier
        .notifyOperationResult({
          operator: job.createdBy,
          operation: job.jobType,
          result: "failed",
          detail: `${classified.category}: ${classified.detail}`,
          jobId: job.id,
        })
        .catch((notifyError) => {
          console.log(`[daemon-notify-warning] ${notifyError instanceof Error ? notifyError.message : String(notifyError)}`);
        });
    } else if (failed.requeued && job.source === "feishu_manual") {
      await notifyOperationStageBestEffort(notifier, {
        operator: job.createdBy,
        operation: job.jobType,
        result: "queued",
        detail: `任务失败后已重试入队（retry=${failed.retryCount}/${job.maxRetries}）。`,
        jobId: job.id,
      });
    }
  }
}

function buildSharedSubprocessArgs(args: CliArgs): string[] {
  const shared: string[] = [
    "src/cli.ts",
    "run",
    "--source-config",
    args.sourceConfigPath,
    "--runtime-config-path",
    args.runtimeConfigPath,
    "--storage-backend",
    args.storageBackend,
    "--storage-db-path",
    args.storageDbPath,
    "--timezone",
    args.timezone,
    "--output-root",
    args.outputRoot,
    "--publish-root",
    args.publishRoot,
    "--review-instruction-root",
    args.reviewInstructionRoot,
    "--watch-lock-file",
    args.watchLockFile,
    "--watch-max-retries",
    String(args.watchMaxRetries),
    "--watch-retry-delay-ms",
    String(args.watchRetryDelayMs),
    "--watch-summary-root",
    args.watchSummaryRoot,
    "--notification-root",
    args.notificationRoot,
  ];
  if (!args.storageFallbackToFile) {
    shared.push("--storage-no-fallback");
  }
  return shared;
}

function buildRunReportSubprocessArgs(
  args: CliArgs,
  payload: {
    mode: "daily" | "weekly";
    mock: boolean;
    reportDate?: string;
    generatedAt?: string;
  },
) {
  const cliArgs = [...buildSharedSubprocessArgs(args), "--mode", payload.mode];
  if (payload.mock) {
    cliArgs.push("--mock");
  }
  if (payload.reportDate) {
    cliArgs.push("--report-date", payload.reportDate);
  }
  if (payload.generatedAt) {
    cliArgs.push("--generated-at", payload.generatedAt);
  }
  return cliArgs;
}

function buildRecheckSubprocessArgs(
  args: CliArgs,
  payload: {
    reportDate: string;
    generatedAt?: string;
  },
) {
  const cliArgs = [...buildSharedSubprocessArgs(args), "--mode", "weekly", "--recheck-pending", "--report-date", payload.reportDate];
  if (payload.generatedAt) {
    cliArgs.push("--generated-at", payload.generatedAt);
  }
  return cliArgs;
}

function buildWatchdogSubprocessArgs(
  args: CliArgs,
  payload: {
    dryRun: boolean;
    generatedAt?: string;
  },
) {
  const cliArgs = [...buildSharedSubprocessArgs(args), "--mode", "weekly", "--watch-pending-weekly"];
  if (payload.dryRun) {
    cliArgs.push("--dry-run");
  }
  if (payload.generatedAt) {
    cliArgs.push("--generated-at", payload.generatedAt);
  }
  return cliArgs;
}

function buildReminderSubprocessArgs(
  args: CliArgs,
  payload: {
    generatedAt?: string;
  },
) {
  const cliArgs = [...buildSharedSubprocessArgs(args), "--mode", "weekly", "--notify-review-reminder"];
  if (payload.generatedAt) {
    cliArgs.push("--generated-at", payload.generatedAt);
  }
  return cliArgs;
}

async function runQueuedCliSubprocess(input: {
  args: CliArgs;
  jobStore: DbOperationJobStore;
  jobId: number;
  cliArgs: string[];
}) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...CLI_SUBPROCESS_BASE_ARGS, ...input.cliArgs], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrText = "";
    let cancelRequested = false;
    let killTimer: NodeJS.Timeout | null = null;
    let pollInFlight = false;

    child.stdout?.on("data", () => {
      // 子进程详细日志仍由其自身 stdout 输出到父进程；这里不再二次转发避免噪音。
    });
    child.stderr?.on("data", (chunk) => {
      stderrText = `${stderrText}${String(chunk)}`.slice(-2_000);
    });

    const pollTimer = setInterval(() => {
      if (pollInFlight || cancelRequested) {
        return;
      }
      pollInFlight = true;
      input.jobStore
        .isCancelRequested(input.jobId)
        .then((requested) => {
          if (!requested || cancelRequested) {
            return;
          }
          cancelRequested = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            if (!child.killed) {
              child.kill("SIGKILL");
            }
          }, HARD_CANCEL_SIGKILL_GRACE_MS);
        })
        .catch((error) => {
          console.log(`[daemon-cancel-poll-warning] ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          pollInFlight = false;
        });
    }, HARD_CANCEL_POLL_MS);

    child.once("error", (error) => {
      clearInterval(pollTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      reject(error);
    });

    child.once("close", (code, signal) => {
      clearInterval(pollTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }

      if (cancelRequested) {
        reject(new OperationCancelledError("cancel_requested_by_operator"));
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      const reason = stderrText.trim() || `code=${code ?? "null"},signal=${signal ?? "none"}`;
      reject(new Error(`subprocess_exit_failed:${reason}`));
    });
  });
}

async function handleFeishuOperationAction(input: {
  args: CliArgs;
  notifier: FeishuNotifier;
  jobStore: DbOperationJobStore;
  payload: FeishuOperationActionPayload;
  enqueueMessage: string;
}) {
  const reportDate = input.payload.reportDate ?? dayjs().tz(input.args.timezone).format("YYYY-MM-DD");
  if (input.payload.operation === "query_weekly_status") {
    const detail = await queryWeeklyStatusDetail(input.args.outputRoot, reportDate, input.jobStore);
    await notifyOperationStageBestEffort(input.notifier, {
      operator: input.payload.operator,
      operation: input.payload.operation,
      result: "success",
      detail,
    });
    return {
      accepted: true,
      message: detail,
    };
  }

  if (input.payload.operation === "cancel_current_operation") {
    const cancelled = await input.jobStore.requestCancelCurrent({
      operator: input.payload.operator,
      reason: input.payload.reason,
    });
    if (!cancelled.found) {
      return {
        accepted: true,
        message: "当前没有可中止的任务。",
      };
    }

    const detail =
      cancelled.status === "cancelled"
        ? cancelled.alreadyRequested
          ? `已强制中止运行中任务（job=${cancelled.jobId}）。`
          : `已中止待执行任务（job=${cancelled.jobId}）。`
        : `已记录中止请求，任务将在当前阶段结束后停止（job=${cancelled.jobId}）。`;
    await notifyOperationStageBestEffort(input.notifier, {
      operator: input.payload.operator,
      operation: input.payload.operation,
      result: "cancelled",
      detail,
      jobId: cancelled.jobId,
    });
    return {
      accepted: true,
      duplicated: cancelled.alreadyRequested ?? false,
      jobId: cancelled.jobId,
      message: detail,
    };
  }

  if (input.payload.operation === "cancel_and_retry_operation") {
    const targetOperation = input.payload.targetOperation;
    if (!targetOperation) {
      return {
        accepted: false,
        message: "缺少 targetOperation，无法执行“中止并重新开始”。",
      };
    }
    const cancelled = await input.jobStore.requestCancelCurrent({
      operator: input.payload.operator,
      reason: input.payload.reason ?? `cancel_and_retry:${targetOperation}`,
    });
    const restartEnqueue = await input.jobStore.enqueue({
      jobType: targetOperation,
      payload: buildOperationPayloadFromFeishuAction(targetOperation, reportDate, input.payload),
      // “中止并重启”是显式运维意图，使用唯一 key 绕过去重窗口，确保可以创建新任务。
      dedupeKey: `manual_restart:${targetOperation}:${reportDate}:${Date.now()}`,
      createdBy: input.payload.operator,
      source: "feishu_manual",
      traceId: input.payload.traceId,
      maxRetries: targetOperation === "watchdog_weekly" ? 0 : 1,
    });
    await notifyOperationStageBestEffort(input.notifier, {
      operator: input.payload.operator,
      operation: targetOperation,
      result: "queued",
      detail: cancelled.found
        ? `已发起中止并重启，新的任务已入队（job=${restartEnqueue.jobId}）。`
        : `未检测到运行中任务，已直接创建新任务（job=${restartEnqueue.jobId}）。`,
      jobId: restartEnqueue.jobId,
    });
    return {
      accepted: true,
      jobId: restartEnqueue.jobId,
      message: `已创建重启任务（job=${restartEnqueue.jobId}）。`,
    };
  }

  if (!isQueueExecutableOperation(input.payload.operation)) {
    return {
      accepted: false,
      message: `暂不支持该运维动作：${input.payload.operation}`,
    };
  }

  const dedupeKey = buildManualOperationDedupeKey({
    operation: input.payload.operation,
    reportDate,
  });
  const enqueue = await input.jobStore.enqueue({
    jobType: input.payload.operation,
    payload: buildOperationPayloadFromFeishuAction(input.payload.operation, reportDate, input.payload),
    dedupeKey,
    createdBy: input.payload.operator,
    source: "feishu_manual",
    traceId: input.payload.traceId,
    maxRetries: input.payload.operation === "watchdog_weekly" ? 0 : 1,
  });
  if (enqueue.created) {
    await notifyOperationStageBestEffort(input.notifier, {
      operator: input.payload.operator,
      operation: input.payload.operation,
      result: "queued",
      detail: "任务已受理并进入队列。",
      jobId: enqueue.jobId,
    });
  } else {
    const existed = await input.jobStore.getById(enqueue.jobId);
    if (existed && (existed.status === "running" || existed.status === "pending")) {
      await notifyOperationStageBestEffort(input.notifier, {
        operator: input.payload.operator,
        operation: input.payload.operation,
        result: "progress",
        detail: `检测到同类任务正在${existed.status === "running" ? "执行" : "排队"}（job=${existed.id}）。`,
        jobId: existed.id,
      });
      await input.notifier
        .notifyOperationConflictControlCard({
          reportDate,
          operation: input.payload.operation,
          runningJobId: existed.id,
        })
        .catch((error) => {
          console.log(`[daemon-notify-warning] ${error instanceof Error ? error.message : String(error)}`);
        });
      return {
        accepted: true,
        duplicated: true,
        jobId: enqueue.jobId,
        message: `检测到同类任务正在执行（job=${existed.id}），已发送“中止/中止并重启”控制卡。`,
      };
    }
  }
  return {
    accepted: true,
    duplicated: !enqueue.created,
    jobId: enqueue.jobId,
    message: enqueue.created ? input.enqueueMessage : "该任务已在队列中，忽略重复提交。",
  };
}

function isQueueExecutableOperation(operation: FeishuOperationActionPayload["operation"]): operation is OperationJobType {
  return (
    operation === "run_daily" ||
    operation === "run_weekly" ||
    operation === "recheck_weekly" ||
    operation === "watchdog_weekly" ||
    operation === "watchdog_weekly_dry_run" ||
    operation === "notify_weekly_reminder" ||
    operation === "query_weekly_status" ||
    operation === "git_sync"
  );
}

async function runAutoGitSync(args: CliArgs, reason: string) {
  return autoSyncToGit({
    repoRoot: process.cwd(),
    includePaths: args.gitSyncIncludePaths,
    commitMessage: `[auto-sync] ${reason}`,
    push: args.gitSyncPush,
    remote: args.gitSyncRemote,
    branch: args.gitSyncBranch,
    httpProxy: args.gitSyncHttpProxy,
    httpsProxy: args.gitSyncHttpsProxy,
    noProxy: args.gitSyncNoProxy,
  });
}

function buildOperationPayloadFromFeishuAction(
  operation: OperationJobType,
  reportDate: string,
  payload: {
    generatedAt?: string;
    dryRun?: boolean;
  },
): Record<string, unknown> {
  const generatedAt = payload.generatedAt ?? new Date().toISOString();
  if (operation === "run_daily") {
    return {
      mode: "daily",
      // 飞书主动触发默认执行真实数据，mock 仅保留给 CLI 显式演练。
      mock: false,
      reportDate,
      generatedAt,
    };
  }
  if (operation === "run_weekly") {
    return {
      mode: "weekly",
      // 飞书主动触发默认执行真实数据，mock 仅保留给 CLI 显式演练。
      mock: false,
      reportDate,
      generatedAt,
    };
  }
  if (operation === "recheck_weekly") {
    return {
      reportDate,
      generatedAt,
    };
  }
  if (operation === "watchdog_weekly" || operation === "watchdog_weekly_dry_run") {
    return {
      dryRun: operation === "watchdog_weekly_dry_run" ? true : payload.dryRun ?? false,
      generatedAt,
    };
  }
  if (operation === "notify_weekly_reminder") {
    return { generatedAt };
  }
  if (operation === "query_weekly_status") {
    return { reportDate };
  }
  return {
    reason: `manual_trigger:${reportDate}`,
  };
}

async function queryWeeklyStatusDetail(outputRoot: string, reportDate: string, jobStore: DbOperationJobStore): Promise<string> {
  const active = await jobStore.listActive(100);
  const matched = active.filter((job) => getOperationReportDate(job.payload) === reportDate);
  const running = matched.find((job) => job.status === "running");
  const pendingCount = matched.filter((job) => job.status === "pending").length;

  try {
    const artifact = await loadReviewArtifact(outputRoot, "weekly", reportDate);
    const queueSummary = running
      ? `, queue=running(${running.jobType}#${running.id}), pending=${pendingCount}`
      : pendingCount > 0
        ? `, queue=pending(${pendingCount})`
        : "";
    return `status: review=${artifact.reviewStatus}, stage=${artifact.reviewStage}, publish=${artifact.publishStatus}${queueSummary}`;
  } catch {
    if (running) {
      return `status: reportDate=${reportDate} 正在执行（${running.jobType}#${running.id}），pending=${pendingCount}`;
    }
    if (pendingCount > 0) {
      return `status: reportDate=${reportDate} 队列中有待执行任务（pending=${pendingCount}）`;
    }
    return `status: reportDate=${reportDate} 暂无可用周报产物`;
  }
}

function getOperationReportDate(payload: Record<string, unknown>): string | undefined {
  const value = payload.reportDate;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  return undefined;
}

class OperationCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationCancelledError";
  }
}

function classifyOperationFailure(message: string): { category: string; detail: string } {
  const text = message.toLowerCase();
  if (text.includes("timeout") || text.includes("timed out")) {
    return { category: "timeout", detail: message };
  }
  if (text.includes("http_") || text.includes("http ") || text.includes("fetch failed") || text.includes("econn")) {
    return { category: "upstream_http_error", detail: message };
  }
  if (text.includes("sqlite") || text.includes("db") || text.includes("database")) {
    return { category: "db_error", detail: message };
  }
  if (text.includes("zod") || text.includes("validation") || text.includes("invalid")) {
    return { category: "validation_error", detail: message };
  }
  return { category: "unknown", detail: message };
}

async function notifyOperationStageBestEffort(
  notifier: FeishuNotifier,
  input: {
    operator?: string;
    operation: FeishuOperationActionPayload["operation"];
    result: "queued" | "started" | "progress" | "success" | "failed" | "cancelled";
    detail: string;
    jobId?: number;
  },
) {
  await notifier.notifyOperationResult(input).catch((error) => {
    console.log(`[daemon-notify-warning] ${error instanceof Error ? error.message : String(error)}`);
  });
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0) {
    return defaults();
  }

  const args = defaults();

  // 保持轻量参数解析，避免引入额外 CLI 框架影响学习成本。
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === "run") {
      args.command = "run";
      continue;
    }

    if (token === "--mode" && next) {
      if (next !== "daily" && next !== "weekly") {
        throw new Error("--mode 只支持 daily 或 weekly");
      }
      args.mode = next;
      i += 1;
      continue;
    }

    if (token === "--mock") {
      args.mock = true;
      continue;
    }

    if (token === "--source-config" && next) {
      args.sourceConfigPath = next;
      i += 1;
      continue;
    }

    if (token === "--runtime-config-path" && next) {
      args.runtimeConfigPath = next;
      i += 1;
      continue;
    }

    if (token === "--storage-backend" && next) {
      if (next !== "file" && next !== "db") {
        throw new Error("--storage-backend 只支持 file 或 db");
      }
      args.storageBackend = next;
      i += 1;
      continue;
    }

    if (token === "--storage-db-path" && next) {
      args.storageDbPath = next;
      i += 1;
      continue;
    }

    if (token === "--storage-no-fallback") {
      args.storageFallbackToFile = false;
      continue;
    }

    if (token === "--source-limit" && next) {
      args.sourceLimit = Number(next);
      i += 1;
      continue;
    }

    if (token === "--llm-summary-enabled") {
      args.llmSummaryEnabled = true;
      continue;
    }

    if (token === "--llm-classify-score-enabled") {
      args.llmClassifyScoreEnabled = true;
      continue;
    }

    if (token === "--llm-classify-score-disabled") {
      args.llmClassifyScoreEnabled = false;
      continue;
    }

    if (token === "--llm-classify-score-batch-size" && next) {
      args.llmClassifyScoreBatchSize = Number(next);
      i += 1;
      continue;
    }

    if (token === "--llm-classify-score-timeout-ms" && next) {
      args.llmClassifyScoreTimeoutMs = Number(next);
      i += 1;
      continue;
    }

    if (token === "--llm-classify-score-max-concurrency" && next) {
      args.llmClassifyScoreMaxConcurrency = Number(next);
      i += 1;
      continue;
    }

    if (token === "--llm-classify-score-min-confidence" && next) {
      args.llmClassifyScoreMinConfidence = Number(next);
      i += 1;
      continue;
    }

    if (token === "--llm-classify-score-prompt-version" && next) {
      args.llmClassifyScorePromptVersion = next;
      i += 1;
      continue;
    }

    if (token === "--llm-summary-provider" && next) {
      if (next !== "minimax") {
        throw new Error("--llm-summary-provider 当前仅支持 minimax");
      }
      args.llmSummaryProvider = next;
      i += 1;
      continue;
    }

    if (token === "--llm-summary-minimax-api-key" && next) {
      args.llmSummaryMinimaxApiKey = next;
      i += 1;
      continue;
    }

    if (token === "--llm-summary-minimax-model" && next) {
      args.llmSummaryMinimaxModel = next;
      i += 1;
      continue;
    }

    if (token === "--llm-summary-timeout-ms" && next) {
      args.llmSummaryTimeoutMs = Number(next);
      i += 1;
      continue;
    }

    if (token === "--llm-summary-max-items" && next) {
      args.llmSummaryMaxItems = Number(next);
      i += 1;
      continue;
    }

    if (token === "--llm-summary-max-concurrency" && next) {
      args.llmSummaryMaxConcurrency = Number(next);
      i += 1;
      continue;
    }

    if (token === "--llm-summary-prompt-version" && next) {
      args.llmSummaryPromptVersion = next;
      i += 1;
      continue;
    }

    // 修订 Agent 护栏统一由 CLI/ENV 注入到 state，便于线上排障时临时调参。
    if (token === "--revision-agent-enabled") {
      args.revisionAgentEnabled = true;
      continue;
    }

    if (token === "--revision-agent-disabled") {
      args.revisionAgentEnabled = false;
      continue;
    }

    if (token === "--revision-agent-max-steps" && next) {
      args.revisionAgentMaxSteps = Number(next);
      i += 1;
      continue;
    }

    if (token === "--revision-agent-max-wall-clock-ms" && next) {
      args.revisionAgentMaxWallClockMs = Number(next);
      i += 1;
      continue;
    }

    if (token === "--revision-agent-max-llm-calls" && next) {
      args.revisionAgentMaxLlmCalls = Number(next);
      i += 1;
      continue;
    }

    if (token === "--revision-agent-max-tool-errors" && next) {
      args.revisionAgentMaxToolErrors = Number(next);
      i += 1;
      continue;
    }

    if (token === "--revision-agent-planner-timeout-ms" && next) {
      args.revisionAgentPlannerTimeoutMs = Number(next);
      i += 1;
      continue;
    }

    if (token === "--llm-global-max-concurrency" && next) {
      args.llmGlobalMaxConcurrency = Number(next);
      i += 1;
      continue;
    }

    if (token === "--llm-rank-fusion-weight" && next) {
      args.llmRankFusionWeight = Number(next);
      i += 1;
      continue;
    }

    if (token === "--llm-assist-min-confidence" && next) {
      args.llmAssistMinConfidence = Number(next);
      i += 1;
      continue;
    }

    if (token === "--llm-fallback-alert-disabled") {
      args.llmFallbackAlertEnabled = false;
      continue;
    }

    if (token === "--timezone" && next) {
      args.timezone = next;
      i += 1;
      continue;
    }

    if (token === "--output-root" && next) {
      args.outputRoot = next;
      i += 1;
      continue;
    }

    if (token === "--publish-root" && next) {
      args.publishRoot = next;
      i += 1;
      continue;
    }

    if (token === "--review-instruction-root" && next) {
      args.reviewInstructionRoot = next;
      i += 1;
      continue;
    }

    if (token === "--approve-outline") {
      args.approveOutline = true;
      continue;
    }

    if (token === "--approve-final") {
      args.approveFinal = true;
      continue;
    }

    if (token === "--recheck-pending") {
      args.recheckPending = true;
      continue;
    }

    if (token === "--watch-pending-weekly") {
      args.watchPendingWeekly = true;
      continue;
    }

    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (token === "--watch-lock-file" && next) {
      args.watchLockFile = next;
      i += 1;
      continue;
    }

    if (token === "--watch-force-unlock") {
      args.watchForceUnlock = true;
      continue;
    }

    if (token === "--watch-max-retries" && next) {
      args.watchMaxRetries = Number(next);
      i += 1;
      continue;
    }

    if (token === "--watch-retry-delay-ms" && next) {
      args.watchRetryDelayMs = Number(next);
      i += 1;
      continue;
    }

    if (token === "--watch-summary-root" && next) {
      args.watchSummaryRoot = next;
      i += 1;
      continue;
    }

    if (token === "--serve-feishu-callback") {
      args.serveFeishuCallback = true;
      continue;
    }

    if (token === "--serve-review-api") {
      args.serveReviewApi = true;
      continue;
    }

    if (token === "--migrate-file-to-db") {
      args.migrateFileToDb = true;
      continue;
    }

    if (token === "--notify-review-reminder") {
      args.notifyReviewReminder = true;
      continue;
    }

    if (token === "--daemon") {
      args.daemon = true;
      continue;
    }

    if (token === "--daemon-scheduler-interval-ms" && next) {
      args.daemonSchedulerIntervalMs = Number(next);
      i += 1;
      continue;
    }

    if (token === "--daemon-worker-poll-ms" && next) {
      args.daemonWorkerPollMs = Number(next);
      i += 1;
      continue;
    }

    if (token === "--daemon-marker-root" && next) {
      args.daemonMarkerRoot = next;
      i += 1;
      continue;
    }

    if (token === "--auto-git-sync") {
      args.autoGitSync = true;
      continue;
    }

    if (token === "--git-sync-no-push") {
      args.gitSyncPush = false;
      continue;
    }

    if (token === "--git-sync-remote" && next) {
      args.gitSyncRemote = next;
      i += 1;
      continue;
    }

    if (token === "--git-sync-branch" && next) {
      args.gitSyncBranch = next;
      i += 1;
      continue;
    }

    if (token === "--git-sync-include-paths" && next) {
      args.gitSyncIncludePaths = next
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      i += 1;
      continue;
    }

    if (token === "--git-sync-http-proxy" && next) {
      args.gitSyncHttpProxy = next;
      i += 1;
      continue;
    }

    if (token === "--git-sync-https-proxy" && next) {
      args.gitSyncHttpsProxy = next;
      i += 1;
      continue;
    }

    if (token === "--git-sync-no-proxy" && next) {
      args.gitSyncNoProxy = next;
      i += 1;
      continue;
    }

    if (token === "--feishu-app-id" && next) {
      args.feishuAppId = next;
      i += 1;
      continue;
    }

    if (token === "--feishu-app-secret" && next) {
      args.feishuAppSecret = next;
      i += 1;
      continue;
    }

    if (token === "--feishu-review-chat-id" && next) {
      args.feishuReviewChatId = next;
      i += 1;
      continue;
    }

    if (token === "--report-public-base-url" && next) {
      args.reportPublicBaseUrl = next;
      i += 1;
      continue;
    }

    if (token === "--feishu-notification-root" && next) {
      args.feishuNotificationRoot = next;
      i += 1;
      continue;
    }

    if (token === "--feishu-debug-verbose") {
      args.feishuDebugVerbose = true;
      continue;
    }

    if (token === "--feishu-callback-host" && next) {
      args.feishuCallbackHost = next;
      i += 1;
      continue;
    }

    if (token === "--feishu-callback-port" && next) {
      args.feishuCallbackPort = Number(next);
      i += 1;
      continue;
    }

    if (token === "--feishu-callback-path" && next) {
      args.feishuCallbackPath = next;
      i += 1;
      continue;
    }

    if (token === "--feishu-callback-auth-token" && next) {
      args.feishuCallbackAuthToken = next;
      i += 1;
      continue;
    }

    if (token === "--feishu-signing-secret" && next) {
      args.feishuSigningSecret = next;
      i += 1;
      continue;
    }

    if (token === "--review-api-host" && next) {
      args.reviewApiHost = next;
      i += 1;
      continue;
    }

    if (token === "--review-api-port" && next) {
      args.reviewApiPort = Number(next);
      i += 1;
      continue;
    }

    if (token === "--review-api-auth-token" && next) {
      args.reviewApiAuthToken = next;
      i += 1;
      continue;
    }

    if (token === "--notification-root" && next) {
      args.notificationRoot = next;
      i += 1;
      continue;
    }

    if (token === "--report-date" && next) {
      args.reportDate = next;
      i += 1;
      continue;
    }

    if (token === "--generated-at" && next) {
      args.generatedAt = next;
      i += 1;
      continue;
    }
  }

  return args;
}

function defaults(): CliArgs {
  const feishu = loadFeishuConfigFromEnv();
  return {
    command: "run",
    mode: "weekly",
    mock: false,
    sourceConfigPath: "data/sources.yaml",
    runtimeConfigPath: "outputs/runtime-config/global.json",
    storageBackend: (process.env.STORAGE_BACKEND as "file" | "db" | undefined) ?? "db",
    storageDbPath: process.env.STORAGE_DB_PATH ?? "outputs/db/app.sqlite",
    storageFallbackToFile: process.env.STORAGE_FALLBACK_TO_FILE !== "false",
    sourceLimit: 6,
    llmSummaryEnabled: process.env.LLM_SUMMARY_ENABLED === "true",
    llmClassifyScoreEnabled: process.env.LLM_CLASSIFY_SCORE_ENABLED !== "false",
    llmClassifyScoreBatchSize: Number(process.env.LLM_CLASSIFY_SCORE_BATCH_SIZE ?? "10"),
    llmClassifyScoreTimeoutMs: Number(process.env.LLM_CLASSIFY_SCORE_TIMEOUT_MS ?? "60000"),
    llmClassifyScoreMaxConcurrency: Number(process.env.LLM_CLASSIFY_SCORE_MAX_CONCURRENCY ?? "2"),
    llmClassifyScoreMinConfidence: Number(process.env.LLM_CLASSIFY_SCORE_MIN_CONFIDENCE ?? "0.6"),
    llmClassifyScorePromptVersion: process.env.LLM_CLASSIFY_SCORE_PROMPT_VERSION ?? "m5.4-v1",
    llmSummaryProvider: process.env.LLM_SUMMARY_PROVIDER === "minimax" ? "minimax" : "minimax",
    llmSummaryMinimaxApiKey: process.env.MINIMAX_API_KEY ?? process.env.ANTHROPIC_API_KEY,
    llmSummaryMinimaxModel: process.env.MINIMAX_MODEL ?? "MiniMax-M2.5",
    llmSummaryTimeoutMs: Number(process.env.LLM_SUMMARY_TIMEOUT_MS ?? "12000"),
    llmSummaryMaxItems: Number(process.env.LLM_SUMMARY_MAX_ITEMS ?? "30"),
    llmSummaryMaxConcurrency: Number(process.env.LLM_SUMMARY_MAX_CONCURRENCY ?? "2"),
    llmGlobalMaxConcurrency: Number(process.env.LLM_GLOBAL_MAX_CONCURRENCY ?? "2"),
    llmRankFusionWeight: Number(process.env.LLM_RANK_FUSION_WEIGHT ?? "0.65"),
    llmAssistMinConfidence: Number(process.env.LLM_ASSIST_MIN_CONFIDENCE ?? "0.5"),
    llmSummaryPromptVersion: process.env.LLM_SUMMARY_PROMPT_VERSION ?? "m5.3-v1",
    llmFallbackAlertEnabled: process.env.LLM_FALLBACK_ALERT_ENABLED !== "false",
    // ReAct 修订默认开启；当 provider 波动时可通过环境变量一键降级回结构化修订。
    revisionAgentEnabled: process.env.REVISION_AGENT_ENABLED !== "false",
    revisionAgentMaxSteps: Number(process.env.REVISION_AGENT_MAX_STEPS ?? "20"),
    revisionAgentMaxWallClockMs: Number(process.env.REVISION_AGENT_MAX_WALL_CLOCK_MS ?? "600000"),
    revisionAgentMaxLlmCalls: Number(process.env.REVISION_AGENT_MAX_LLM_CALLS ?? "30"),
    revisionAgentMaxToolErrors: Number(process.env.REVISION_AGENT_MAX_TOOL_ERRORS ?? "5"),
    revisionAgentPlannerTimeoutMs: Number(process.env.REVISION_AGENT_PLANNER_TIMEOUT_MS ?? "30000"),
    timezone: "Asia/Shanghai",
    outputRoot: "outputs/review",
    publishRoot: "outputs/published",
    reviewInstructionRoot: "outputs/review-instructions",
    approveOutline: false,
    approveFinal: false,
    recheckPending: false,
    watchPendingWeekly: false,
    dryRun: false,
    watchLockFile: "outputs/watchdog/weekly.lock",
    watchForceUnlock: false,
    watchMaxRetries: 2,
    watchRetryDelayMs: 300,
    watchSummaryRoot: "outputs/watchdog",
    serveFeishuCallback: false,
    serveReviewApi: false,
    migrateFileToDb: false,
    notifyReviewReminder: false,
    daemon: false,
    daemonSchedulerIntervalMs: Number(process.env.DAEMON_SCHEDULER_INTERVAL_MS ?? "30000"),
    daemonWorkerPollMs: Number(process.env.DAEMON_WORKER_POLL_MS ?? "2000"),
    daemonMarkerRoot: process.env.DAEMON_MARKER_ROOT ?? "outputs/daemon/schedule-markers",
    autoGitSync: process.env.AUTO_GIT_SYNC === "true",
    gitSyncPush: process.env.GIT_SYNC_PUSH === "true",
    gitSyncRemote: process.env.GIT_SYNC_REMOTE ?? "origin",
    gitSyncBranch: process.env.GIT_SYNC_BRANCH,
    gitSyncIncludePaths: (process.env.GIT_SYNC_INCLUDE_PATHS ??
      "outputs/review,outputs/published,outputs/review-instructions,outputs/runtime-config")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
    gitSyncHttpProxy: process.env.GIT_PUSH_HTTP_PROXY,
    gitSyncHttpsProxy: process.env.GIT_PUSH_HTTPS_PROXY,
    gitSyncNoProxy: process.env.GIT_PUSH_NO_PROXY,
    feishuAppId: feishu.appId,
    feishuAppSecret: feishu.appSecret,
    feishuReviewChatId: feishu.reviewChatId,
    reportPublicBaseUrl: feishu.reportPublicBaseUrl,
    feishuNotificationRoot: feishu.notificationRoot ?? "outputs/notifications/feishu",
    feishuDebugVerbose: feishu.debugVerbose ?? false,
    feishuCallbackHost: feishu.callbackHost,
    feishuCallbackPort: feishu.callbackPort,
    feishuCallbackPath: feishu.callbackPath,
    feishuCallbackAuthToken: feishu.callbackAuthToken,
    feishuSigningSecret: feishu.callbackSigningSecret,
    reviewApiHost: process.env.REVIEW_API_HOST ?? "127.0.0.1",
    reviewApiPort: Number(process.env.REVIEW_API_PORT ?? "8790"),
    reviewApiAuthToken: process.env.REVIEW_API_AUTH_TOKEN,
    notificationRoot: "outputs/notifications/feishu",
  };
}

async function persistOutputs(result: ReportState, args: CliArgs, trigger: "run" | "recheck" | "watchdog") {
  // 输出目录按 reportDate 分桶，保证 recheck 场景不会覆盖到错误日期。
  const datePart = result.reportDate;

  // 约定始终先写入 review 目录，作为可追溯的待审核基线版本。
  const reviewPaths = await writeArtifacts(args.outputRoot, args.mode, datePart, result);
  console.log(`[output] ${reviewPaths.mdPath}`);
  console.log(`[output] ${reviewPaths.jsonPath}`);

  // 满足发布条件时，再同步写入 published 目录。
  if (result.shouldPublish) {
    const publishedPaths = await writeArtifacts(args.publishRoot, args.mode, datePart, result);
    console.log(`[published] ${publishedPaths.mdPath}`);
    console.log(`[published] ${publishedPaths.jsonPath}`);
    // 优先尝试 Git 同步，再通知群组，尽量保证通知内链接在用户点击时已可访问。
    await autoSyncOutputsIfNeeded(args, `publish:${result.mode}:${result.reportDate}`);
    await notifyPublishResultIfNeeded(args, result, publishedPaths.mdPath);
    await notifyDailyPublishResultIfNeeded(args, result, publishedPaths.mdPath);
    await notifyLlmFallbackIfNeeded(args, result);
    return;
  }

  // 审核通知前先同步产物，减少“卡片已到达但链接尚不可访问”的窗口。
  await autoSyncOutputsIfNeeded(args, `review:${result.mode}:${result.reportDate}`);
  await notifyReviewPendingIfNeeded(args, result, reviewPaths.mdPath, trigger);
  await notifyLlmFallbackIfNeeded(args, result);
}

async function autoSyncOutputsIfNeeded(args: CliArgs, reason: string) {
  if (!args.autoGitSync) {
    return;
  }

  try {
    const sync = await runAutoGitSync(args, reason);
    console.log(
      `[git-sync] changed=${sync.changed}, committed=${sync.committed}, pushed=${sync.pushed}, files=${sync.changedFiles.length}`,
    );
  } catch (error) {
    // Git 同步失败不应阻断主流程，避免通知/发布被版本控制链路拖垮。
    console.log(`[git-sync-warning] ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeArtifacts(root: string, mode: ReportMode, datePart: string, result: ReportState) {
  const dir = path.join(root, mode);
  await fs.mkdir(dir, { recursive: true });

  const mdPath = path.join(dir, `${datePart}.md`);
  const jsonPath = path.join(dir, `${datePart}.json`);

  await fs.writeFile(mdPath, result.reportMarkdown, "utf-8");
  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        runId: result.runId,
        generatedAt: result.generatedAt,
        reviewStartedAt: result.reviewStartedAt,
        reportDate: result.reportDate,
        mode: result.mode,
        reviewStatus: result.reviewStatus,
        reviewStage: result.reviewStage,
        reviewDeadlineAt: result.reviewDeadlineAt,
        reviewReason: result.reviewReason,
        publishStatus: result.publishStatus,
        shouldPublish: result.shouldPublish,
        publishReason: result.publishReason,
        publishedAt: result.publishedAt,
        outlineApproved: result.outlineApproved,
        finalApproved: result.finalApproved,
        rejected: result.rejected,
        metrics: result.metrics,
        itemSummaries: result.itemSummaries,
        quickDigest: result.quickDigest,
        leadSummary: result.leadSummary,
        categoryLeadSummaries: result.categoryLeadSummaries,
        summaryInputHash: result.summaryInputHash,
        llmClassifyScoreMeta: result.llmClassifyScoreMeta,
        llmSummaryMeta: result.llmSummaryMeta,
        highlights: result.highlights,
        revisionAuditLogs: result.revisionAuditLogs,
        warnings: result.warnings,
        snapshot: {
          timezone: result.timezone,
          sourceConfigPath: result.sourceConfigPath,
          runtimeConfigPath: result.runtimeConfigPath,
          storageBackend: result.storageBackend,
          storageDbPath: result.storageDbPath,
          storageFallbackToFile: result.storageFallbackToFile,
          sourceLimit: result.sourceLimit,
          outlineMarkdown: result.outlineMarkdown,
          rankedItems: result.rankedItems,
          itemSummaries: result.itemSummaries,
          quickDigest: result.quickDigest,
          leadSummary: result.leadSummary,
          categoryLeadSummaries: result.categoryLeadSummaries,
          summaryInputHash: result.summaryInputHash,
          llmClassifyScoreMeta: result.llmClassifyScoreMeta,
          llmSummaryMeta: result.llmSummaryMeta,
          highlights: result.highlights,
          metrics: result.metrics,
          warnings: result.warnings,
          reviewDeadlineAt: result.reviewDeadlineAt,
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  return { mdPath, jsonPath };
}

async function notifyReviewPendingIfNeeded(
  args: CliArgs,
  result: ReportState,
  reviewMarkdownPath: string,
  trigger: "run" | "recheck" | "watchdog",
) {
  if (result.mode !== "weekly" || result.reviewStatus !== "pending_review" || result.publishStatus !== "pending") {
    return;
  }
  const notifier = createFeishuNotifier(args);
  if (!notifier.isEnabled()) {
    return;
  }

  const reviewStage = result.reviewStage === "none" ? "final_review" : result.reviewStage;

  try {
    await notifier.notifyReviewPending({
      runId: result.runId,
      reportDate: result.reportDate,
      reviewStage,
      reviewDeadlineAt: result.reviewDeadlineAt,
      reviewMarkdownPath,
    });
    console.log(`[feishu-notify] pending review ${trigger === "run" ? "sent" : "updated"}: ${result.reportDate}`);
  } catch (error) {
    // 通知失败不影响报告产物落盘，避免协同链路拖垮主流程。
    console.log(`[feishu-notify-warning] pending review failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function notifyPublishResultIfNeeded(args: CliArgs, result: ReportState, publishMarkdownPath: string) {
  if (result.mode !== "weekly") {
    return;
  }
  const notifier = createFeishuNotifier(args);
  if (!notifier.isEnabled()) {
    return;
  }

  try {
    await notifier.notifyPublishResult({
      runId: result.runId,
      reportDate: result.reportDate,
      reviewStatus: result.reviewStatus,
      publishReason: result.publishReason,
      publishMarkdownPath,
    });
    console.log(`[feishu-notify] publish result sent: ${result.reportDate}`);
  } catch (error) {
    console.log(`[feishu-notify-warning] publish result failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function notifyDailyPublishResultIfNeeded(args: CliArgs, result: ReportState, publishMarkdownPath: string) {
  if (result.mode !== "daily") {
    return;
  }
  const notifier = createFeishuNotifier(args);
  if (!notifier.isEnabled()) {
    return;
  }

  try {
    await notifier.notifyDailyPublishResult({
      runId: result.runId,
      reportDate: result.reportDate,
      publishReason: result.publishReason,
      publishMarkdownPath,
    });
    console.log(`[feishu-notify] daily publish result sent: ${result.reportDate}`);
  } catch (error) {
    console.log(
      `[feishu-notify-warning] daily publish result failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function notifyLlmFallbackIfNeeded(args: CliArgs, result: ReportState) {
  if (!args.llmFallbackAlertEnabled) {
    return;
  }
  if (!result.llmSummaryMeta.enabled || !result.llmSummaryMeta.fallbackTriggered) {
    return;
  }
  const notifier = createFeishuNotifier(args);
  if (!notifier.isEnabled()) {
    return;
  }
  try {
    await notifier.notifyLlmFallback({
      runId: result.runId,
      reportDate: result.reportDate,
      mode: result.mode,
      reason: result.llmSummaryMeta.fallbackReason ?? "unknown",
    });
    console.log(`[feishu-notify] llm fallback alert sent: ${result.reportDate}`);
  } catch (error) {
    console.log(`[feishu-notify-warning] llm fallback alert failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createFeishuNotifier(args: CliArgs) {
  // CLI 与回调服务统一走同一 notifier 工厂，避免多处通道策略分叉。
  return new FeishuNotifier({
    appId: args.feishuAppId,
    appSecret: args.feishuAppSecret,
    reviewChatId: args.feishuReviewChatId,
    reportPublicBaseUrl: args.reportPublicBaseUrl,
    notificationRoot: args.feishuNotificationRoot,
    debugVerbose: args.feishuDebugVerbose,
  });
}

function createFeishuCallbackAuditLogger(args: CliArgs) {
  if (args.storageBackend !== "db") {
    return undefined;
  }

  // 回调审计仅在 DB 模式启用，避免 file-only 部署额外引入持久化副作用。
  const auditStore = new DbAuditStore(new SqliteEngine(args.storageDbPath));
  return async (event: FeishuCallbackAuditEvent) => {
    await auditStore.append({
      eventType: "feishu_callback_action_result",
      entityType: "weekly_report",
      entityId: event.reportDate,
      operator: event.operator,
      source: "feishu_callback",
      traceId: event.traceId,
      createdAt: event.createdAt,
      payload: {
        action: event.action,
        stage: event.stage,
        result: event.result,
        notifyResult: event.notifyResult,
        messageId: event.messageId,
        errorMessage: event.errorMessage,
      },
    });
  };
}

async function loadStatusEchoFromArtifact(outputRoot: string, reportDate: string) {
  try {
    const artifact = await loadReviewArtifact(outputRoot, "weekly", reportDate);
    return {
      reviewStage: artifact.reviewStage,
      reviewStatus: artifact.reviewStatus,
      publishStatus: artifact.publishStatus,
      shouldPublish: artifact.shouldPublish,
      note: "系统状态已更新，若刚完成点击可稍后重试查看。",
    };
  } catch {
    // 首次点击可能尚未生成该日期产物，此时回退到动作级状态推断。
    return null;
  }
}

async function loadReviewArtifact(outputRoot: string, mode: ReportMode, reportDate: string) {
  const artifactPath = path.join(outputRoot, mode, `${reportDate}.json`);
  const content = await fs.readFile(artifactPath, "utf-8");
  const parsed = reviewArtifactSchema.parse(JSON.parse(content));

  if (parsed.mode !== mode) {
    throw new Error(`复检目标模式不匹配: expected=${mode}, actual=${parsed.mode}`);
  }

  return { ...parsed, reportDate: parsed.reportDate ?? reportDate };
}

async function loadWatchdogCandidates(args: CliArgs): Promise<{
  candidates: WatchdogCandidate[];
  precheckFailures: { reportDate: string; status: "failed"; reason: string; attempts: number }[];
}> {
  const weeklyDir = path.join(args.outputRoot, "weekly");
  let fileNames: string[] = [];
  try {
    fileNames = await fs.readdir(weeklyDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { candidates: [], precheckFailures: [] };
    }
    throw error;
  }

  const candidates: WatchdogCandidate[] = [];
  const precheckFailures: { reportDate: string; status: "failed"; reason: string; attempts: number }[] = [];
  for (const name of fileNames.sort()) {
    if (!name.endsWith(".json")) {
      continue;
    }

    const reportDate = name.replace(/\.json$/, "");
    try {
      const artifact = await loadReviewArtifact(args.outputRoot, "weekly", reportDate);
      candidates.push({ reportDate, artifact });
    } catch (error) {
      // 解析失败的文件在守护模式下不抛出，避免单个坏文件阻断全局巡检。
      precheckFailures.push({
        reportDate,
        status: "failed",
        reason: `invalid_review_artifact:${error instanceof Error ? error.message : String(error)}`,
        attempts: 0,
      });
    }
  }
  return { candidates, precheckFailures };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildRecheckStateFromArtifact(input: {
  args: CliArgs;
  artifact: ReviewArtifact;
  reportDate: string;
  generatedAt: string;
  runId: string;
}): ReportState {
  const { args, artifact, reportDate, generatedAt, runId } = input;
  if (!artifact.snapshot) {
    throw new Error(`待复检报告缺少 snapshot（${reportDate}）`);
  }

  // 复检复用已生成快照，避免重新采集导致“审核版本”和“发布版本”内容不一致。
  const state = createInitialState({
    mode: "weekly",
    timezone: artifact.snapshot.timezone,
    useMock: false,
    sourceConfigPath: artifact.snapshot.sourceConfigPath,
    runtimeConfigPath: artifact.snapshot.runtimeConfigPath ?? args.runtimeConfigPath,
    storageBackend: artifact.snapshot.storageBackend ?? args.storageBackend,
    storageDbPath: artifact.snapshot.storageDbPath ?? args.storageDbPath,
    storageFallbackToFile: artifact.snapshot.storageFallbackToFile ?? args.storageFallbackToFile,
    sourceLimit: artifact.snapshot.sourceLimit,
    llmSummaryEnabled: args.llmSummaryEnabled,
    llmClassifyScoreEnabled: args.llmClassifyScoreEnabled,
    llmClassifyScoreBatchSize: args.llmClassifyScoreBatchSize,
    llmClassifyScoreTimeoutMs: args.llmClassifyScoreTimeoutMs,
    llmClassifyScoreMaxConcurrency: args.llmClassifyScoreMaxConcurrency,
    llmClassifyScoreMinConfidence: args.llmClassifyScoreMinConfidence,
    llmClassifyScorePromptVersion: args.llmClassifyScorePromptVersion,
    llmSummaryProvider: args.llmSummaryProvider,
    llmSummaryMinimaxApiKey: args.llmSummaryMinimaxApiKey,
    llmSummaryMinimaxModel: args.llmSummaryMinimaxModel,
    llmSummaryTimeoutMs: args.llmSummaryTimeoutMs,
    llmSummaryMaxItems: args.llmSummaryMaxItems,
    llmSummaryMaxConcurrency: args.llmSummaryMaxConcurrency,
    llmGlobalMaxConcurrency: args.llmGlobalMaxConcurrency,
    llmRankFusionWeight: args.llmRankFusionWeight,
    llmAssistMinConfidence: args.llmAssistMinConfidence,
    llmSummaryPromptVersion: args.llmSummaryPromptVersion,
    llmFallbackAlertEnabled: args.llmFallbackAlertEnabled,
    revisionAgentEnabled: args.revisionAgentEnabled,
    revisionAgentMaxSteps: args.revisionAgentMaxSteps,
    revisionAgentMaxWallClockMs: args.revisionAgentMaxWallClockMs,
    revisionAgentMaxLlmCalls: args.revisionAgentMaxLlmCalls,
    revisionAgentMaxToolErrors: args.revisionAgentMaxToolErrors,
    revisionAgentPlannerTimeoutMs: args.revisionAgentPlannerTimeoutMs,
    generatedAt,
    reviewStartedAt: artifact.reviewStartedAt ?? artifact.generatedAt,
    reportDate,
    runId,
    approveOutline: args.approveOutline,
    approveFinal: args.approveFinal,
    reviewInstructionRoot: args.reviewInstructionRoot,
  });

  return {
    ...state,
    rankedItems: artifact.snapshot.rankedItems,
    itemSummaries: artifact.snapshot.itemSummaries ?? artifact.itemSummaries ?? [],
    quickDigest: artifact.snapshot.quickDigest ?? artifact.quickDigest ?? [],
    leadSummary: artifact.snapshot.leadSummary ?? artifact.leadSummary ?? "",
    categoryLeadSummaries: artifact.snapshot.categoryLeadSummaries ?? artifact.categoryLeadSummaries ?? [],
    summaryInputHash: artifact.snapshot.summaryInputHash ?? artifact.summaryInputHash ?? "",
    llmClassifyScoreMeta: artifact.snapshot.llmClassifyScoreMeta ??
      artifact.llmClassifyScoreMeta ?? {
        enabled: false,
        inputCount: 0,
        processedCount: 0,
        fallbackCount: 0,
        fallbackTriggered: false,
      },
    llmSummaryMeta: artifact.snapshot.llmSummaryMeta ??
      artifact.llmSummaryMeta ?? {
        enabled: false,
        inputCount: 0,
        summarizedCount: 0,
        fallbackTriggered: false,
      },
    highlights: artifact.snapshot.highlights,
    outlineMarkdown: artifact.snapshot.outlineMarkdown,
    metrics: artifact.snapshot.metrics,
    warnings: artifact.snapshot.warnings,
    reviewDeadlineAt: artifact.snapshot.reviewDeadlineAt,
    reviewStatus: artifact.reviewStatus,
    reviewStage: artifact.reviewStage,
    reviewReason: artifact.reviewReason,
    publishStatus: artifact.publishStatus,
    shouldPublish: artifact.shouldPublish,
    publishReason: artifact.publishReason,
    publishedAt: artifact.publishedAt,
    outlineApproved: artifact.outlineApproved ?? false,
    finalApproved: artifact.finalApproved ?? false,
    rejected: artifact.rejected ?? artifact.reviewStatus === "rejected",
    revisionAuditLogs: artifact.revisionAuditLogs ?? [],
  };
}

async function persistWatchdogSummary(args: CliArgs, generatedAt: string, summary: Awaited<ReturnType<typeof runPendingWeeklyWatchdog>>) {
  const dir = path.join(args.watchSummaryRoot, "weekly");
  await fs.mkdir(dir, { recursive: true });
  const stamp = generatedAt.replaceAll(":", "-");
  const summaryPath = path.join(dir, `${stamp}.json`);

  await fs.writeFile(
    summaryPath,
    JSON.stringify(
      {
        mode: "weekly",
        generatedAt,
        dryRun: args.dryRun,
        retries: {
          maxRetries: args.watchMaxRetries,
          retryDelayMs: args.watchRetryDelayMs,
        },
        lockFile: args.watchLockFile,
        summary,
      },
      null,
      2,
    ),
    "utf-8",
  );

  return summaryPath;
}

async function tryAcquireWatchdogLock(lockPath: string, forceUnlock: boolean) {
  try {
    return await acquireFileLock(lockPath, { forceUnlock });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("watchdog_lock_exists:")) {
      return null;
    }
    throw error;
  }
}

function printRunResult(prefix: "done" | "recheck", result: ReportState) {
  const itemCount = result.rankedItems.length;
  if (prefix === "done") {
    console.log(`[done] report generated with ${itemCount} items.`);
  } else {
    console.log(`[done] recheck finished with ${itemCount} items.`);
  }

  console.log(
    `[status] review=${result.reviewStatus}, stage=${result.reviewStage}, publish=${result.publishStatus}, shouldPublish=${result.shouldPublish}`,
  );

  if (result.warnings.length > 0) {
    console.log("[warning] 流程包含 warning:");
    for (const warning of result.warnings) {
      console.log(`- ${warning}`);
    }
  }
}

main().catch((error) => {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
