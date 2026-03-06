import fs from "node:fs/promises";
import path from "node:path";

import dayjs from "dayjs";
import { z } from "zod";

import type {
  ReportMode,
  ReviewInstruction,
  ReviewInstructionAction,
  ReviewInstructionSource,
  ReviewInstructionStage,
} from "../core/types.js";
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

const instructionStageSchema = z.enum(["outline_review", "final_review"]);

const instructionActionSchema = z.enum(["approve_outline", "approve_final", "request_revision", "reject"]);
const instructionSourceSchema = z.enum(["cli", "feishu_callback"]);

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
      .sort((a, b) => dayjs(b.decidedAt).valueOf() - dayjs(a.decidedAt).valueOf());

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
    const merged = [...existing.instructions, nextInstruction].sort(
      (a, b) => dayjs(a.decidedAt).valueOf() - dayjs(b.decidedAt).valueOf(),
    );

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
    feedback: input.feedback,
  });
}

function resolveInstructionDecision(instruction: Pick<ReviewInstruction, "approved" | "action">): boolean {
  if (typeof instruction.approved === "boolean") {
    return instruction.approved;
  }

  if (instruction.action === "approve_outline" || instruction.action === "approve_final") {
    return true;
  }

  // request_revision/reject 在 M3.2 先按“未通过当前阶段”处理，后续 M3.3 再接入修订分支语义。
  return false;
}
