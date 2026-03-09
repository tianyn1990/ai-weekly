import { z } from "zod";

export const metricsSchema = z.object({
  collectedCount: z.number(),
  normalizedCount: z.number(),
  dedupedCount: z.number(),
  highImportanceCount: z.number(),
  mediumImportanceCount: z.number(),
  lowImportanceCount: z.number(),
  categoryBreakdown: z.object({
    "open-source": z.number(),
    tooling: z.number(),
    agent: z.number(),
    research: z.number(),
    "industry-news": z.number(),
    tutorial: z.number(),
    other: z.number(),
  }),
});

export const rankedItemSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  title: z.string(),
  titleZh: z.string().optional(),
  link: z.string(),
  contentSnippet: z.string(),
  publishedAt: z.string(),
  category: z.enum(["open-source", "tooling", "agent", "research", "industry-news", "tutorial", "other"]),
  score: z.number(),
  importance: z.enum(["high", "medium", "low"]),
  recommendationReason: z.string(),
  domainTag: z.string().optional(),
  intentTag: z.string().optional(),
  actionability: z.number().optional(),
  confidence: z.number().optional(),
  llmScore: z.number().optional(),
  scoreBreakdown: z
    .object({
      ruleScore: z.number(),
      ruleScoreNormalized: z.number(),
      llmScore: z.number().optional(),
      finalScore: z.number(),
      fusionWeight: z.number(),
      usedLlm: z.boolean(),
    })
    .optional(),
});

const llmItemSummarySchema = z.object({
  itemId: z.string(),
  title: z.string(),
  titleZh: z.string().optional(),
  summary: z.string(),
  recommendation: z.string(),
  evidenceItemIds: z.array(z.string()),
  domainTag: z.string().optional(),
  intentTag: z.string().optional(),
  actionability: z.number().optional(),
  confidence: z.number().optional(),
  llmScore: z.number().optional(),
});

const llmQuickDigestSchema = z.object({
  itemId: z.string().optional(),
  title: z.string(),
  takeaway: z.string(),
  evidenceItemIds: z.array(z.string()),
});

const llmSummaryMetaSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(["minimax"]).optional(),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationMs: z.number().optional(),
  inputCount: z.number(),
  summarizedCount: z.number(),
  fallbackTriggered: z.boolean(),
  fallbackReason: z.string().optional(),
  effectiveConcurrency: z.number().optional(),
  assistAppliedCount: z.number().optional(),
  assistFallbackCount: z.number().optional(),
  leadFallbackTriggered: z.boolean().optional(),
  failureStats: z
    .object({
      totalFailed: z.number(),
      timeout: z.number(),
      http: z.number(),
      business: z.number(),
      missingContent: z.number(),
      invalidJson: z.number(),
      quality: z.number(),
      other: z.number(),
    })
    .optional(),
  retryStats: z
    .object({
      retryableTriggeredCount: z.number(),
      missingContentExtraRetryTriggeredCount: z.number(),
      compensationRetryItemCount: z.number(),
      serialDegradeTriggered: z.boolean(),
      serialRetriedItemCount: z.number(),
      serialTriggerMaxConsecutiveMissingContent: z.number(),
    })
    .optional(),
});

export const reviewArtifactSchema = z.object({
  runId: z.string(),
  generatedAt: z.string(),
  reviewStartedAt: z.string().optional(),
  reportDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  mode: z.enum(["daily", "weekly"]),
  reviewStatus: z.enum(["not_required", "pending_review", "approved", "timeout_published", "rejected"]),
  reviewStage: z.enum(["none", "outline_review", "final_review"]),
  reviewDeadlineAt: z.string().nullable(),
  reviewReason: z.string(),
  publishStatus: z.enum(["pending", "published"]),
  shouldPublish: z.boolean(),
  publishReason: z.string(),
  publishedAt: z.string().nullable(),
  outlineApproved: z.boolean().optional(),
  finalApproved: z.boolean().optional(),
  rejected: z.boolean().optional(),
  metrics: metricsSchema,
  itemSummaries: z.array(llmItemSummarySchema).optional(),
  quickDigest: z.array(llmQuickDigestSchema).optional(),
  leadSummary: z.string().optional(),
  summaryInputHash: z.string().optional(),
  llmSummaryMeta: llmSummaryMetaSchema.optional(),
  highlights: z.array(rankedItemSchema),
  revisionAuditLogs: z
    .array(
      z.object({
        at: z.string(),
        stage: z.enum(["outline_review", "final_review"]),
        operator: z.string().optional(),
        reason: z.string().optional(),
        addedCount: z.number(),
        removedCount: z.number(),
        beforeCount: z.number(),
        afterCount: z.number(),
        globalConfigChanges: z.array(z.string()),
        notes: z.string().optional(),
      }),
    )
    .optional(),
  warnings: z.array(z.string()),
  snapshot: z
    .object({
      timezone: z.string(),
      sourceConfigPath: z.string(),
      runtimeConfigPath: z.string().optional(),
      storageBackend: z.enum(["file", "db"]).optional(),
      storageDbPath: z.string().optional(),
      storageFallbackToFile: z.boolean().optional(),
      sourceLimit: z.number(),
      outlineMarkdown: z.string(),
      rankedItems: z.array(rankedItemSchema),
      itemSummaries: z.array(llmItemSummarySchema).optional(),
      quickDigest: z.array(llmQuickDigestSchema).optional(),
      leadSummary: z.string().optional(),
      summaryInputHash: z.string().optional(),
      llmSummaryMeta: llmSummaryMetaSchema.optional(),
      highlights: z.array(rankedItemSchema),
      metrics: metricsSchema,
      warnings: z.array(z.string()),
      reviewDeadlineAt: z.string().nullable(),
    })
    .optional(),
});

export type ReviewArtifact = z.infer<typeof reviewArtifactSchema>;
