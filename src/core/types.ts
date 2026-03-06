export type ReportMode = "daily" | "weekly";

export type SourceType = "rss";

export type ItemCategory =
  | "open-source"
  | "tooling"
  | "agent"
  | "research"
  | "industry-news"
  | "tutorial"
  | "other";

export type ImportanceLevel = "high" | "medium" | "low";

export type ReviewStatus = "not_required" | "pending_review" | "approved" | "timeout_published" | "rejected";

export type ReviewStage = "none" | "outline_review" | "final_review";

export type PublishStatus = "pending" | "published";

export type ReviewInstructionStage = Exclude<ReviewStage, "none">;

export type ReviewInstructionSource = "cli" | "feishu_callback";

export type ReviewInstructionAction = "approve_outline" | "approve_final" | "request_revision" | "reject";

export interface FeedbackCandidateAddition {
  title: string;
  link?: string;
  summary?: string;
  category?: ItemCategory;
  sourceId?: string;
  sourceName?: string;
}

export interface FeedbackCandidateRemoval {
  id?: string;
  link?: string;
}

export interface FeedbackSourceToggle {
  sourceId: string;
  enabled: boolean;
}

export interface FeedbackSourceWeightAdjustment {
  sourceId: string;
  weight: number;
}

export type RankingWeightDimension = "source" | "freshness" | "keyword";

export interface FeedbackRankingWeightAdjustment {
  dimension: RankingWeightDimension;
  weight: number;
}

export interface ReviewFeedbackPayload {
  candidateAdditions?: FeedbackCandidateAddition[];
  candidateRemovals?: FeedbackCandidateRemoval[];
  newTopics?: string[];
  newSearchTerms?: string[];
  sourceToggles?: FeedbackSourceToggle[];
  sourceWeightAdjustments?: FeedbackSourceWeightAdjustment[];
  rankingWeightAdjustments?: FeedbackRankingWeightAdjustment[];
  editorNotes?: string;
}

export interface RevisionAuditLog {
  at: string;
  stage: ReviewInstructionStage;
  operator?: string;
  reason?: string;
  addedCount: number;
  removedCount: number;
  beforeCount: number;
  afterCount: number;
  globalConfigChanges: string[];
  notes?: string;
}

export interface ReviewInstruction {
  mode: ReportMode;
  reportDate: string;
  stage: ReviewInstructionStage;
  approved?: boolean;
  action?: ReviewInstructionAction;
  decidedAt: string;
  source?: ReviewInstructionSource;
  operator?: string;
  reason?: string;
  traceId?: string;
  messageId?: string;
  feedback?: ReviewFeedbackPayload;
}

export interface SourceConfig {
  id: string;
  name: string;
  type: SourceType;
  url: string;
  language: "zh" | "en" | "mixed";
  weight: number;
  enabled: boolean;
}

export interface RawItem {
  sourceId: string;
  sourceName: string;
  title: string;
  link: string;
  contentSnippet: string;
  publishedAt?: string;
}

export interface NormalizedItem {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  link: string;
  contentSnippet: string;
  publishedAt: string;
  category: ItemCategory;
}

export interface RankedItem extends NormalizedItem {
  score: number;
  importance: ImportanceLevel;
  recommendationReason: string;
}

export interface PipelineMetrics {
  collectedCount: number;
  normalizedCount: number;
  dedupedCount: number;
  highImportanceCount: number;
  mediumImportanceCount: number;
  lowImportanceCount: number;
  categoryBreakdown: Record<ItemCategory, number>;
}

export interface ReportState {
  runId: string;
  mode: ReportMode;
  timezone: string;
  generatedAt: string;
  reviewStartedAt: string;
  reportDate: string;
  useMock: boolean;
  sourceConfigPath: string;
  runtimeConfigPath: string;
  sourceLimit: number;
  reviewInstructionRoot: string;
  rawItems: RawItem[];
  items: NormalizedItem[];
  rankedItems: RankedItem[];
  highlights: RankedItem[];
  outlineMarkdown: string;
  reportMarkdown: string;
  approveOutline: boolean;
  approveFinal: boolean;
  outlineApproved: boolean;
  finalApproved: boolean;
  rejected: boolean;
  reviewStatus: ReviewStatus;
  reviewStage: ReviewStage;
  reviewDeadlineAt: string | null;
  reviewReason: string;
  publishStatus: PublishStatus;
  shouldPublish: boolean;
  publishedAt: string | null;
  publishReason: string;
  metrics: PipelineMetrics;
  revisionAuditLogs: RevisionAuditLog[];
  warnings: string[];
}
