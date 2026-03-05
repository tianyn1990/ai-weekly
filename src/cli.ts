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
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command !== "run") {
    throw new Error("仅支持 run 命令。示例: pnpm run:weekly:mock");
  }

  const generatedAt = nowInTimezoneIso(args.timezone);
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
  });

  const result = (await graph.invoke(initialState as any)) as ReportState;
  await persistOutputs(result, args);

  console.log(`[done] report generated with ${result.rankedItems.length} items.`);
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
  };
}

async function persistOutputs(result: ReportState, args: CliArgs) {
  const datePart = new Date().toISOString().slice(0, 10);
  const dir = path.join(args.outputRoot, args.mode);
  await fs.mkdir(dir, { recursive: true });

  const mdPath = path.join(dir, `${datePart}.md`);
  const jsonPath = path.join(dir, `${datePart}.json`);

  // 约定同时输出 Markdown + JSON，便于人工审核与后续自动发布/检索。
  await fs.writeFile(mdPath, result.reportMarkdown, "utf-8");
  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        runId: result.runId,
        generatedAt: result.generatedAt,
        mode: result.mode,
        metrics: result.metrics,
        highlights: result.highlights,
        warnings: result.warnings,
      },
      null,
      2,
    ),
    "utf-8",
  );

  console.log(`[output] ${mdPath}`);
  console.log(`[output] ${jsonPath}`);
}

main().catch((error) => {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
