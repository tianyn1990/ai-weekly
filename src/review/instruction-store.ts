import fs from "node:fs/promises";
import path from "node:path";

import dayjs from "dayjs";
import { z } from "zod";

import { DbAuditStore } from "../audit/audit-store.js";
import type {
  ReportMode,
  ReviewInstruction,
  ReviewInstructionAction,
  ReviewInstructionSource,
  ReviewInstructionStage,
} from "../core/types.js";
import { SqliteEngine } from "../storage/sqlite-engine.js";
import { reviewFeedbackPayloadSchema } from "./feedback-schema.js";

export interface GetReviewInstructionInput {
  mode: ReportMode;
  reportDate: string;
  stage: ReviewInstructionStage;
  decidedAfterOrAt?: string;
}

export interface ReviewInstructionStore {
  getLatestDecision(input: GetReviewInstructionInput): Promise<boolean | null>;
  getLatestInstruction(input: GetReviewInstructionInput): Promise<ReviewInstruction | null>;
  appendInstruction(input: ReviewInstruction): Promise<void>;
}

export interface CreateReviewInstructionStoreInput {
  backend: "file" | "db";
  fileRoot: string;
  dbPath: string;
  fallbackToFile: boolean;
}

const instructionStageSchema = z.enum(["outline_review", "final_review"]);

const instructionActionSchema = z.enum(["approve_outline", "approve_final", "request_revision", "reject"]);
const instructionSourceSchema = z.enum(["cli", "feishu_callback", "api"]);

const instructionRecordSchema = z
  .object({
    stage: instructionStageSchema,
    approved: z.boolean().optional(),
    action: instructionActionSchema.optional(),
    decidedAt: z.string().datetime(),
    source: instructionSourceSchema.optional(),
    operator: z.string().min(1).optional(),
    reason: z.string().optional(),
    traceId: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    feedback: reviewFeedbackPayloadSchema.optional(),
  })
  .superRefine((value, ctx) => {
    // 兼容 M2 历史格式（approved），同时支持 M3+ 的 action 驱动写法。
    if (value.approved === undefined && value.action === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "审核指令必须至少包含 approved 或 action 字段",
      });
    }
  });

const instructionFileSchema = z.object({
  mode: z.enum(["daily", "weekly"]).optional(),
  reportDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  instructions: z.array(instructionRecordSchema),
});

const dbInstructionRowSchema = z.object({
  mode: z.enum(["daily", "weekly"]),
  report_date: z.string(),
  stage: instructionStageSchema,
  approved: z.number().nullable().optional(),
  action: instructionActionSchema.nullable().optional(),
  decided_at: z.string(),
  source: instructionSourceSchema.nullable().optional(),
  operator: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  trace_id: z.string().nullable().optional(),
  message_id: z.string().nullable().optional(),
  run_id: z.string().nullable().optional(),
  feedback_json: z.string().nullable().optional(),
});

export function createReviewInstructionStore(input: CreateReviewInstructionStoreInput): ReviewInstructionStore {
  if (input.backend === "file") {
    return new FileReviewInstructionStore(input.fileRoot);
  }

  const dbStore = new DbReviewInstructionStore(new SqliteEngine(input.dbPath));
  if (!input.fallbackToFile) {
    return dbStore;
  }

  return new HybridReviewInstructionStore({
    primary: dbStore,
    fallback: new FileReviewInstructionStore(input.fileRoot),
  });
}

export class FileReviewInstructionStore implements ReviewInstructionStore {
  constructor(private readonly rootDir: string) {}

  async getLatestDecision(input: GetReviewInstructionInput): Promise<boolean | null> {
    const latest = await this.getLatestInstruction(input);
    if (!latest) {
      return null;
    }
    return resolveInstructionDecision(latest);
  }

  async getLatestInstruction(input: GetReviewInstructionInput): Promise<ReviewInstruction | null> {
    const filePath = path.join(this.rootDir, input.mode, `${input.reportDate}.json`);
    const payload = await readInstructionFile(filePath);
    if (!payload) {
      return null;
    }

    // 允许文件记录 mode/reportDate，若存在则做一致性校验，防止误读错误文件。
    if (payload.mode && payload.mode !== input.mode) {
      throw new Error(`审核指令 mode 不匹配: expected=${input.mode}, actual=${payload.mode}`);
    }
    if (payload.reportDate && payload.reportDate !== input.reportDate) {
      throw new Error(`审核指令 reportDate 不匹配: expected=${input.reportDate}, actual=${payload.reportDate}`);
    }

    const matched = payload.instructions
      .filter((instruction) => instruction.stage === input.stage)
      .filter((instruction) => {
        if (!input.decidedAfterOrAt) {
          return true;
        }
        return dayjs(instruction.decidedAt).isSame(dayjs(input.decidedAfterOrAt)) || dayjs(instruction.decidedAt).isAfter(dayjs(input.decidedAfterOrAt));
      })
      .sort((a, b) => {
        const byTime = dayjs(b.decidedAt).valueOf() - dayjs(a.decidedAt).valueOf();
        return byTime;
      });

    if (matched.length === 0) {
      return null;
    }

    return {
      mode: input.mode,
      reportDate: input.reportDate,
      stage: matched[0].stage,
      approved: matched[0].approved,
      action: matched[0].action,
      decidedAt: matched[0].decidedAt,
      source: matched[0].source,
      operator: matched[0].operator,
      reason: matched[0].reason,
      traceId: matched[0].traceId,
      messageId: matched[0].messageId,
      runId: matched[0].runId,
      feedback: matched[0].feedback,
    };
  }

  async appendInstruction(input: ReviewInstruction): Promise<void> {
    const filePath = path.join(this.rootDir, input.mode, `${input.reportDate}.json`);
    const existing = (await readInstructionFile(filePath)) ?? {
      mode: input.mode,
      reportDate: input.reportDate,
      instructions: [],
    };

    // 统一由存储层做写入前校验，避免不同入口写入不一致数据。
    ensurePayloadMatchesTarget(existing, input.mode, input.reportDate);
    const nextInstruction = normalizeInstruction(input);
    const merged = [...existing.instructions, nextInstruction].sort((a, b) => dayjs(a.decidedAt).valueOf() - dayjs(b.decidedAt).valueOf());

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          mode: input.mode,
          reportDate: input.reportDate,
          instructions: merged,
        },
        null,
        2,
      ),
      "utf-8",
    );
  }
}

export class DbReviewInstructionStore implements ReviewInstructionStore {
  private readonly auditStore: DbAuditStore;

  constructor(private readonly engine: SqliteEngine) {
    this.auditStore = new DbAuditStore(engine);
  }

  async getLatestDecision(input: GetReviewInstructionInput): Promise<boolean | null> {
    const latest = await this.getLatestInstruction(input);
    if (!latest) {
      return null;
    }
    return resolveInstructionDecision(latest);
  }

  async getLatestInstruction(input: GetReviewInstructionInput): Promise<ReviewInstruction | null> {
    return this.engine.read((ctx) => {
      const whereParts = ["mode = $mode", "report_date = $reportDate", "stage = $stage"];
      const params: Record<string, unknown> = {
        $mode: input.mode,
        $reportDate: input.reportDate,
        $stage: input.stage,
      };
      if (input.decidedAfterOrAt) {
        whereParts.push("decided_at >= $decidedAfterOrAt");
        params.$decidedAfterOrAt = input.decidedAfterOrAt;
      }

      const row = ctx.queryOne(
        `
        SELECT mode, report_date, stage, approved, action, decided_at, source, operator, reason, trace_id, message_id, run_id, feedback_json
        FROM review_instructions
        WHERE ${whereParts.join(" AND ")}
        ORDER BY decided_at DESC, id DESC
        LIMIT 1;
        `,
        params,
      );

      if (!row) {
        return null;
      }

      return toReviewInstructionFromDbRow(dbInstructionRowSchema.parse(row));
    });
  }

  async appendInstruction(input: ReviewInstruction): Promise<void> {
    const normalized = normalizeInstruction(input);
    await this.engine.write((ctx) => {
      ctx.run(
        `
        INSERT INTO review_instructions (
          mode, report_date, run_id, stage, action, approved, decided_at, source, operator, reason, trace_id, message_id, feedback_json, created_at
        ) VALUES (
          $mode, $reportDate, $runId, $stage, $action, $approved, $decidedAt, $source, $operator, $reason, $traceId, $messageId, $feedbackJson, $createdAt
        );
        `,
        {
          $mode: input.mode,
          $reportDate: input.reportDate,
          $runId: input.runId ?? null,
          $stage: normalized.stage,
          $action: normalized.action ?? null,
          $approved: typeof normalized.approved === "boolean" ? (normalized.approved ? 1 : 0) : null,
          $decidedAt: normalized.decidedAt,
          $source: normalized.source ?? null,
          $operator: normalized.operator ?? null,
          $reason: normalized.reason ?? null,
          $traceId: normalized.traceId ?? null,
          $messageId: normalized.messageId ?? null,
          $feedbackJson: normalized.feedback ? JSON.stringify(normalized.feedback) : null,
          $createdAt: new Date().toISOString(),
        },
      );
    });

    // 审核动作是关键业务事件，额外写入审计表便于 trace 追踪与后续排障。
    await this.auditStore.append({
      eventType: "review_instruction_appended",
      entityType: "review_instruction",
      entityId: `${input.mode}:${input.reportDate}:${input.stage}`,
      payload: {
        mode: input.mode,
        reportDate: input.reportDate,
        stage: input.stage,
        action: normalized.action,
        approved: normalized.approved,
        decidedAt: normalized.decidedAt,
      },
      operator: normalized.operator,
      source: normalized.source,
      traceId: normalized.traceId,
      createdAt: new Date().toISOString(),
    });
  }
}

class HybridReviewInstructionStore implements ReviewInstructionStore {
  constructor(
    private readonly input: {
      primary: ReviewInstructionStore;
      fallback: ReviewInstructionStore;
    },
  ) {}

  async getLatestDecision(input: GetReviewInstructionInput): Promise<boolean | null> {
    const instruction = await this.getLatestInstruction(input);
    if (!instruction) {
      return null;
    }
    return resolveInstructionDecision(instruction);
  }

  async getLatestInstruction(input: GetReviewInstructionInput): Promise<ReviewInstruction | null> {
    try {
      return await this.input.primary.getLatestInstruction(input);
    } catch {
      return this.input.fallback.getLatestInstruction(input);
    }
  }

  async appendInstruction(input: ReviewInstruction): Promise<void> {
    await this.input.primary.appendInstruction(input);
    // 镜像写入失败不阻断主链路，避免 fallback 存储抖动影响主路径。
    try {
      await this.input.fallback.appendInstruction(input);
    } catch {
      // no-op
    }
  }
}

async function readInstructionFile(filePath: string) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return instructionFileSchema.parse(JSON.parse(content));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function ensurePayloadMatchesTarget(payload: z.infer<typeof instructionFileSchema>, mode: ReportMode, reportDate: string) {
  // 允许文件记录 mode/reportDate，若存在则做一致性校验，防止误读或误写错误文件。
  if (payload.mode && payload.mode !== mode) {
    throw new Error(`审核指令 mode 不匹配: expected=${mode}, actual=${payload.mode}`);
  }
  if (payload.reportDate && payload.reportDate !== reportDate) {
    throw new Error(`审核指令 reportDate 不匹配: expected=${reportDate}, actual=${payload.reportDate}`);
  }
}

function normalizeInstruction(input: ReviewInstruction) {
  const source: ReviewInstructionSource | undefined = input.source;
  const action: ReviewInstructionAction | undefined = input.action;
  return instructionRecordSchema.parse({
    stage: input.stage,
    approved: input.approved,
    action,
    decidedAt: input.decidedAt,
    source,
    operator: input.operator,
    reason: input.reason,
    traceId: input.traceId,
    messageId: input.messageId,
    runId: input.runId,
    feedback: input.feedback,
  });
}

function toReviewInstructionFromDbRow(row: z.infer<typeof dbInstructionRowSchema>): ReviewInstruction {
  return {
    mode: row.mode,
    reportDate: row.report_date,
    stage: row.stage,
    approved: typeof row.approved === "number" ? row.approved === 1 : undefined,
    action: row.action ?? undefined,
    decidedAt: row.decided_at,
    source: row.source ?? undefined,
    operator: row.operator ?? undefined,
    reason: row.reason ?? undefined,
    traceId: row.trace_id ?? undefined,
    messageId: row.message_id ?? undefined,
    runId: row.run_id ?? undefined,
    feedback: row.feedback_json ? (JSON.parse(row.feedback_json) as ReviewInstruction["feedback"]) : undefined,
  };
}

function resolveInstructionDecision(instruction: Pick<ReviewInstruction, "approved" | "action">): boolean {
  if (typeof instruction.approved === "boolean") {
    return instruction.approved;
  }

  if (instruction.action === "approve_outline" || instruction.action === "approve_final") {
    return true;
  }

  // request_revision/reject 不代表当前阶段通过。
  return false;
}
