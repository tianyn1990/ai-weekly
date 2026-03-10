import { describe, expect, it } from "vitest";

import type { RankedItem, RevisionAuditLog, ReviewInstruction } from "../src/core/types.js";
import { createEmptyMetrics } from "../src/core/utils.js";
import { executeRevisionWithAgent } from "../src/review/revision-agent.js";

function createRankedItem(overrides: Partial<RankedItem> = {}): RankedItem {
  return {
    id: "item-1",
    sourceId: "source-a",
    sourceName: "Source A",
    title: "Agent 工程实践",
    link: "https://example.com/a",
    contentSnippet: "原始摘要",
    publishedAt: "2026-03-10T00:00:00.000Z",
    category: "agent",
    score: 88,
    importance: "high",
    recommendationReason: "原始推荐",
    ...overrides,
  };
}

function createInstruction(feedback: ReviewInstruction["feedback"]): ReviewInstruction {
  return {
    mode: "weekly",
    reportDate: "2026-03-10",
    stage: "final_review",
    action: "request_revision",
    decidedAt: "2026-03-10T01:00:00.000Z",
    feedback,
  };
}

function createBaseInput(options?: {
  rankedItems?: RankedItem[];
  instruction?: ReviewInstruction;
  revisionAuditLogs?: RevisionAuditLog[];
  maxSteps?: number;
}) {
  return {
    mode: "weekly" as const,
    generatedAt: "2026-03-10T01:00:00.000Z",
    sourceConfigPath: "data/sources.yaml",
    runtimeConfigPath: "outputs/runtime-config/global.json",
    storageBackend: "file" as const,
    storageDbPath: "outputs/db/app.sqlite",
    storageFallbackToFile: true,
    rankedItems: options?.rankedItems ?? [createRankedItem()],
    metrics: createEmptyMetrics(),
    instruction: options?.instruction ?? createInstruction({ revisionRequest: "新增 一条资讯 https://example.com/new" }),
    revisionAuditLogs: options?.revisionAuditLogs ?? [],
    settings: {
      enabled: true,
      maxSteps: options?.maxSteps ?? 20,
      maxWallClockMs: 600000,
      maxLlmCalls: 0,
      maxToolErrors: 5,
      plannerTimeoutMs: 30000,
    },
    llm: {
      provider: "minimax" as const,
      apiKey: undefined,
      model: "MiniMax-M2.5",
    },
  };
}

describe("revision-agent", () => {
  it("应支持基于自由文本新增候选条目", async () => {
    const result = await executeRevisionWithAgent(createBaseInput());
    expect(result.rankedItems.length).toBeGreaterThan(1);
    expect(result.auditLog.addedCount).toBeGreaterThanOrEqual(1);
    expect(result.failureCategory).toBeUndefined();
  });

  it("应支持基于自由文本删除命中条目", async () => {
    const input = createBaseInput({
      instruction: createInstruction({
        revisionRequest: "删除 Agent 工程实践",
      }),
    });
    const result = await executeRevisionWithAgent(input);
    expect(result.rankedItems.length).toBe(0);
    expect(result.auditLog.removedCount).toBe(1);
  });

  it("步数达到上限时应返回 step_limit_reached 并保留 checkpoint", async () => {
    const input = createBaseInput({
      instruction: createInstruction({
        revisionRequest: "新增 条目A https://example.com/a1；新增 条目B https://example.com/a2；新增 条目C https://example.com/a3",
      }),
      maxSteps: 1,
    });
    const result = await executeRevisionWithAgent(input);
    expect(result.failureCategory).toBe("step_limit_reached");
    expect(result.hasPendingTasks).toBe(true);
    expect(result.auditLog.notes).toContain("react_checkpoint:");
  });

  it("continueFromCheckpoint=true 时应优先执行 checkpoint 待续任务", async () => {
    const checkpoint = {
      version: 1,
      pendingTasks: [
        {
          id: "resume-1",
          operation: "add_candidate",
          payload: { title: "Checkpoint 新增条目", link: "https://example.com/cp" },
          confidence: 0.8,
        },
      ],
    };
    const logs: RevisionAuditLog[] = [
      {
        at: "2026-03-10T00:50:00.000Z",
        stage: "final_review",
        beforeCount: 1,
        afterCount: 1,
        addedCount: 0,
        removedCount: 0,
        globalConfigChanges: [],
        notes: `react_checkpoint:${JSON.stringify(checkpoint)}`,
      },
    ];
    const input = createBaseInput({
      instruction: createInstruction({
        continueFromCheckpoint: true,
      }),
      revisionAuditLogs: logs,
    });
    const result = await executeRevisionWithAgent(input);
    expect(result.rankedItems.some((item) => item.title.includes("Checkpoint 新增条目"))).toBe(true);
    expect(result.hasPendingTasks).toBe(false);
  });
});

