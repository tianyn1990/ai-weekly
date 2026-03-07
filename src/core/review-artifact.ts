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
  link: z.string(),
  contentSnippet: z.string(),
  publishedAt: z.string(),
  category: z.enum(["open-source", "tooling", "agent", "research", "industry-news", "tutorial", "other"]),
  score: z.number(),
  importance: z.enum(["high", "medium", "low"]),
  recommendationReason: z.string(),
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
      highlights: z.array(rankedItemSchema),
      metrics: metricsSchema,
      warnings: z.array(z.string()),
      reviewDeadlineAt: z.string().nullable(),
    })
    .optional(),
});

export type ReviewArtifact = z.infer<typeof reviewArtifactSchema>;
