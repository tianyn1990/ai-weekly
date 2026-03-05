import fs from "node:fs/promises";
import path from "node:path";

import dayjs from "dayjs";
import { z } from "zod";

import type { ReportMode, ReviewInstructionStage } from "../core/types.js";

export interface GetReviewInstructionInput {
  mode: ReportMode;
  reportDate: string;
  stage: ReviewInstructionStage;
}

export interface ReviewInstructionStore {
  getLatestDecision(input: GetReviewInstructionInput): Promise<boolean | null>;
}

const instructionStageSchema = z.enum(["outline_review", "final_review"]);

const instructionRecordSchema = z.object({
  stage: instructionStageSchema,
  approved: z.boolean(),
  decidedAt: z.string().datetime(),
  operator: z.string().min(1).optional(),
  reason: z.string().optional(),
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
      .sort((a, b) => dayjs(b.decidedAt).valueOf() - dayjs(a.decidedAt).valueOf());

    if (matched.length === 0) {
      return null;
    }

    return matched[0].approved;
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

