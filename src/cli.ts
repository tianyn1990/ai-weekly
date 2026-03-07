#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

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
import { createReviewInstructionStore } from "./review/instruction-store.js";
import { isWeeklyReminderWindowReached, shouldSendWeeklyReminderForArtifact } from "./review/reminder-policy.js";
import { DbAuditStore } from "./audit/audit-store.js";
import { createRuntimeConfigStore } from "./config/runtime-config.js";
import { SqliteEngine } from "./storage/sqlite-engine.js";
import { migrateFileToDb } from "./storage/migrate-file-to-db.js";
import { acquireFileLock } from "./utils/file-lock.js";
import { nowInTimezoneIso } from "./utils/time.js";

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
  feishuWebhookUrl?: string;
  feishuWebhookSecret?: string;
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
  const args = parseArgs(process.argv.slice(2));

  if (args.command !== "run") {
    throw new Error("仅支持 run 命令。示例: pnpm run:weekly:mock");
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

async function runServeFeishuCallback(args: CliArgs) {
  const store = createReviewInstructionStore({
    backend: args.storageBackend,
    dbPath: args.storageDbPath,
    fileRoot: args.reviewInstructionRoot,
    fallbackToFile: args.storageFallbackToFile,
  });
  const server = await startFeishuReviewCallbackServer({
    host: args.feishuCallbackHost,
    port: args.feishuCallbackPort,
    path: args.feishuCallbackPath,
    authToken: args.feishuCallbackAuthToken,
    signingSecret: args.feishuSigningSecret,
    store,
  });

  console.log(
    `[feishu-callback] listening on http://${args.feishuCallbackHost}:${server.port}${args.feishuCallbackPath} (local, 2B)`,
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

  const server = await startReviewApiServer({
    host: args.reviewApiHost,
    port: args.reviewApiPort,
    authToken: args.reviewApiAuthToken,
    outputRoot: args.outputRoot,
    reviewStore,
    runtimeStore,
    auditStore,
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
  const notifier = new FeishuNotifier({
    webhookUrl: args.feishuWebhookUrl,
    webhookSecret: args.feishuWebhookSecret,
  });
  if (!args.feishuWebhookUrl) {
    console.log("[feishu-reminder-skip] FEISHU_WEBHOOK_URL 未配置");
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

    if (token === "--feishu-webhook-url" && next) {
      args.feishuWebhookUrl = next;
      i += 1;
      continue;
    }

    if (token === "--feishu-webhook-secret" && next) {
      args.feishuWebhookSecret = next;
      i += 1;
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
    feishuWebhookUrl: feishu.webhookUrl,
    feishuWebhookSecret: feishu.webhookSecret,
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
    await notifyPublishResultIfNeeded(args, result, publishedPaths.mdPath);
    return;
  }

  await notifyReviewPendingIfNeeded(args, result, reviewPaths.mdPath, trigger);
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
  if (trigger !== "run") {
    return;
  }
  if (result.mode !== "weekly" || result.reviewStatus !== "pending_review" || result.publishStatus !== "pending") {
    return;
  }
  if (!args.feishuWebhookUrl) {
    return;
  }

  const reviewStage = result.reviewStage === "none" ? "final_review" : result.reviewStage;
  const notifier = new FeishuNotifier({
    webhookUrl: args.feishuWebhookUrl,
    webhookSecret: args.feishuWebhookSecret,
  });

  try {
    await notifier.notifyReviewPending({
      reportDate: result.reportDate,
      reviewStage,
      reviewDeadlineAt: result.reviewDeadlineAt,
      reviewMarkdownPath,
    });
    console.log(`[feishu-notify] pending review sent: ${result.reportDate}`);
  } catch (error) {
    // 通知失败不影响报告产物落盘，避免协同链路拖垮主流程。
    console.log(`[feishu-notify-warning] pending review failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function notifyPublishResultIfNeeded(args: CliArgs, result: ReportState, publishMarkdownPath: string) {
  if (result.mode !== "weekly" || !args.feishuWebhookUrl) {
    return;
  }
  const notifier = new FeishuNotifier({
    webhookUrl: args.feishuWebhookUrl,
    webhookSecret: args.feishuWebhookSecret,
  });

  try {
    await notifier.notifyPublishResult({
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
