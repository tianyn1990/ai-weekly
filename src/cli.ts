#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import { buildReportGraph } from "./pipeline/graph.js";
import { createInitialState, loadEnabledSources } from "./pipeline/nodes.js";
import type { ReportMode, ReportState } from "./core/types.js";
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
  approveOutline: boolean;
  approveFinal: boolean;
  generatedAt?: string;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command !== "run") {
    throw new Error("仅支持 run 命令。示例: pnpm run:weekly:mock");
  }

  const generatedAt = args.generatedAt ?? nowInTimezoneIso(args.timezone);
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
    runId,
    approveOutline: args.approveOutline,
    approveFinal: args.approveFinal,
  });

  const result = (await graph.invoke(initialState as any)) as ReportState;
  await persistOutputs(result, args);

  console.log(`[done] report generated with ${result.rankedItems.length} items.`);
  console.log(
    `[status] review=${result.reviewStatus}, stage=${result.reviewStage}, publish=${result.publishStatus}, shouldPublish=${result.shouldPublish}`,
  );

  if (result.warnings.length > 0) {
    console.log("[warning] 部分来源抓取失败:");
    for (const warning of result.warnings) {
      console.log(`- ${warning}`);
    }
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

    if (token === "--approve-outline") {
      args.approveOutline = true;
      continue;
    }

    if (token === "--approve-final") {
      args.approveFinal = true;
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
    approveOutline: false,
    approveFinal: false,
  };
}

async function persistOutputs(result: ReportState, args: CliArgs) {
  // 产物日期统一取生成时间，确保重放历史任务时不会写错日期目录。
  const datePart = result.generatedAt.slice(0, 10);

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
        mode: result.mode,
        reviewStatus: result.reviewStatus,
        reviewStage: result.reviewStage,
        reviewDeadlineAt: result.reviewDeadlineAt,
        reviewReason: result.reviewReason,
        publishStatus: result.publishStatus,
        shouldPublish: result.shouldPublish,
        publishReason: result.publishReason,
        publishedAt: result.publishedAt,
        metrics: result.metrics,
        highlights: result.highlights,
        warnings: result.warnings,
      },
      null,
      2,
    ),
    "utf-8",
  );

  return { mdPath, jsonPath };
}

main().catch((error) => {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
