import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { DbRuntimeConfigStore, loadRuntimeConfig } from "../config/runtime-config.js";
import type { ReviewInstruction } from "../core/types.js";
import { DbReviewInstructionStore } from "../review/instruction-store.js";
import { SqliteEngine } from "./sqlite-engine.js";

const instructionFileSchema = z.object({
  mode: z.enum(["daily", "weekly"]).optional(),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  instructions: z.array(
    z.object({
      stage: z.enum(["outline_review", "final_review"]),
      approved: z.boolean().optional(),
      action: z.enum(["approve_outline", "approve_final", "request_revision", "reject"]).optional(),
      decidedAt: z.string(),
      source: z.enum(["cli", "feishu_callback", "api"]).optional(),
      operator: z.string().optional(),
      reason: z.string().optional(),
      traceId: z.string().optional(),
      messageId: z.string().optional(),
      runId: z.string().optional(),
      feedback: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

export interface MigrateFileToDbInput {
  instructionRoot: string;
  runtimeConfigPath: string;
  dbPath: string;
}

export interface MigrateFileToDbResult {
  instruction: {
    inserted: number;
    skipped: number;
    failed: number;
  };
  runtimeConfig: {
    insertedVersion: number;
  };
}

export async function migrateFileToDb(input: MigrateFileToDbInput): Promise<MigrateFileToDbResult> {
  const engine = new SqliteEngine(input.dbPath);
  const reviewStore = new DbReviewInstructionStore(engine);
  const runtimeStore = new DbRuntimeConfigStore(engine);

  const existingFingerprints = await loadExistingInstructionFingerprints(engine);
  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  for (const mode of ["daily", "weekly"] as const) {
    const modeDir = path.join(input.instructionRoot, mode);
    let names: string[] = [];
    try {
      names = await fs.readdir(modeDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }

    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const reportDate = name.replace(/\.json$/, "");
      try {
        const content = await fs.readFile(path.join(modeDir, name), "utf-8");
        const parsed = instructionFileSchema.parse(JSON.parse(content));
        const effectiveMode = parsed.mode ?? mode;
        const effectiveDate = parsed.reportDate ?? reportDate;
        for (const record of parsed.instructions) {
          const instruction: ReviewInstruction = {
            mode: effectiveMode,
            reportDate: effectiveDate,
            stage: record.stage,
            approved: record.approved,
            action: record.action,
            decidedAt: record.decidedAt,
            source: record.source,
            operator: record.operator,
            reason: record.reason,
            traceId: record.traceId,
            messageId: record.messageId,
            runId: record.runId,
            feedback: record.feedback as ReviewInstruction["feedback"],
          };
          const fingerprint = buildInstructionFingerprint(instruction);
          if (existingFingerprints.has(fingerprint)) {
            skipped += 1;
            continue;
          }

          await reviewStore.appendInstruction(instruction);
          existingFingerprints.add(fingerprint);
          inserted += 1;
        }
      } catch {
        failed += 1;
      }
    }
  }

  const runtime = await loadRuntimeConfig(input.runtimeConfigPath);
  const savedRuntime = await runtimeStore.saveNext({
    config: runtime,
    updatedAt: runtime.updatedAt,
    updatedBy: "migration",
    traceId: "file_to_db_migration",
  });

  return {
    instruction: {
      inserted,
      skipped,
      failed,
    },
    runtimeConfig: {
      insertedVersion: savedRuntime.version,
    },
  };
}

async function loadExistingInstructionFingerprints(engine: SqliteEngine): Promise<Set<string>> {
  return engine.read((ctx) => {
    const rows = ctx.queryMany<{
      mode: string;
      report_date: string;
      stage: string;
      action: string | null;
      approved: number | null;
      decided_at: string;
      source: string | null;
      operator: string | null;
      reason: string | null;
      trace_id: string | null;
      message_id: string | null;
      run_id: string | null;
    }>(
      `
      SELECT mode, report_date, stage, action, approved, decided_at, source, operator, reason, trace_id, message_id, run_id
      FROM review_instructions;
      `,
    );

    const set = new Set<string>();
    for (const row of rows) {
      set.add(
        [
          row.mode,
          row.report_date,
          row.stage,
          row.action ?? "",
          String(row.approved ?? ""),
          row.decided_at,
          row.source ?? "",
          row.operator ?? "",
          row.reason ?? "",
          row.trace_id ?? "",
          row.message_id ?? "",
          row.run_id ?? "",
        ].join("|"),
      );
    }
    return set;
  });
}

function buildInstructionFingerprint(instruction: ReviewInstruction): string {
  return [
    instruction.mode,
    instruction.reportDate,
    instruction.stage,
    instruction.action ?? "",
    String(instruction.approved ?? ""),
    instruction.decidedAt,
    instruction.source ?? "",
    instruction.operator ?? "",
    instruction.reason ?? "",
    instruction.traceId ?? "",
    instruction.messageId ?? "",
    instruction.runId ?? "",
  ].join("|");
}
