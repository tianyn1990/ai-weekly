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
import { acquireFileLock } from "./utils/file-lock.js";
import { nowInTimezoneIso } from "./utils/time.js";

interface CliArgs {
  command: "run";
  mode: ReportMode;
  mock: boolean;
  sourceConfigPath: string;
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

  const enabledSources = await loadEnabledSources(args.sourceConfigPath);
  console.log(`[run] mode=${args.mode}, mock=${args.mock}, sources=${enabledSources.length}`);

  // CLI 只负责 orchestration：准备初始状态、执行 graph、落盘产物。
  const graph = buildReportGraph();
  const initialState = createInitialState({
    mode: args.mode,
    timezone: args.timezone,
    useMock: args.mock,
    sourceConfigPath: args.sourceConfigPath,
    sourceLimit: args.sourceLimit,
    generatedAt,
    reportDate,
    runId,
    approveOutline: args.approveOutline,
    approveFinal: args.approveFinal,
    reviewInstructionRoot: args.reviewInstructionRoot,
  });

  const result = (await graph.invoke(initialState as any)) as ReportState;
  await persistOutputs(result, args);
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
  await persistOutputs(result, args);
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
        await persistOutputs(result, args);
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
  return {
    command: "run",
    mode: "weekly",
    mock: false,
    sourceConfigPath: "data/sources.yaml",
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
  };
}

async function persistOutputs(result: ReportState, args: CliArgs) {
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
        metrics: result.metrics,
        highlights: result.highlights,
        warnings: result.warnings,
        snapshot: {
          timezone: result.timezone,
          sourceConfigPath: result.sourceConfigPath,
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
    sourceLimit: artifact.snapshot.sourceLimit,
    generatedAt,
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
