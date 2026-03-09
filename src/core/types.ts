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

export type ReviewInstructionSource = "cli" | "feishu_callback" | "api";

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

export interface LlmItemSummary {
  itemId: string;
  title: string;
  titleZh?: string;
  summary: string;
  recommendation: string;
  evidenceItemIds: string[];
  domainTag?: string;
  intentTag?: string;
  actionability?: number;
  confidence?: number;
  llmScore?: number;
}

export interface LlmQuickDigestItem {
  itemId?: string;
  title: string;
  takeaway: string;
  evidenceItemIds: string[];
}

export interface CategoryLeadSummary {
  category: ItemCategory;
  lead: string;
  sourceItemIds: string[];
  fallbackTriggered: boolean;
  reason?: string;
}

export interface LlmFailureStats {
  totalFailed: number;
  timeout: number;
  http: number;
  business: number;
  missingContent: number;
  invalidJson: number;
  quality: number;
  other: number;
}

export interface LlmRetryStats {
  retryableTriggeredCount: number;
  missingContentExtraRetryTriggeredCount: number;
  compensationRetryItemCount: number;
  serialDegradeTriggered: boolean;
  serialRetriedItemCount: number;
  serialTriggerMaxConsecutiveMissingContent: number;
}

export interface LlmAdaptiveDegradeStats {
  windowSize: number;
  triggerMissingContentRateThreshold: number;
  recoverSuccessRateThreshold: number;
  triggerCount: number;
  recoverCount: number;
  degradedRetriedItemCount: number;
  currentMode: "normal" | "degraded";
  maxWindowMissingContentRate: number;
  maxWindowSuccessRate: number;
  lastWindowMissingContentRate: number;
  lastWindowSuccessRate: number;
}

export interface LlmSummaryMeta {
  enabled: boolean;
  provider?: "minimax";
  model?: string;
  promptVersion?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  inputCount: number;
  summarizedCount: number;
  fallbackTriggered: boolean;
  fallbackReason?: string;
  effectiveConcurrency?: number;
  assistAppliedCount?: number;
  assistFallbackCount?: number;
  leadFallbackTriggered?: boolean;
  failureStats?: LlmFailureStats;
  retryStats?: LlmRetryStats;
  adaptiveDegradeStats?: LlmAdaptiveDegradeStats;
}

export interface ScoreBreakdown {
  ruleScore: number;
  ruleScoreNormalized: number;
  llmScore?: number;
  finalScore: number;
  fusionWeight: number;
  usedLlm: boolean;
}

export interface ReviewInstruction {
  mode: ReportMode;
  reportDate: string;
  runId?: string;
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
  titleZh?: string;
  domainTag?: string;
  intentTag?: string;
  actionability?: number;
  confidence?: number;
  llmScore?: number;
  scoreBreakdown?: ScoreBreakdown;
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
  storageBackend: "file" | "db";
  storageDbPath: string;
  storageFallbackToFile: boolean;
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
  itemSummaries: LlmItemSummary[];
  quickDigest: LlmQuickDigestItem[];
  leadSummary: string;
  categoryLeadSummaries: CategoryLeadSummary[];
  summaryInputHash: string;
  llmSummaryMeta: LlmSummaryMeta;
  llmSummaryEnabled: boolean;
  llmSummaryProvider: "minimax";
  llmSummaryMinimaxApiKey?: string;
  llmSummaryMinimaxModel: string;
  llmSummaryTimeoutMs: number;
  llmSummaryMaxItems: number;
  llmSummaryMaxConcurrency: number;
  llmGlobalMaxConcurrency: number;
  llmRankFusionWeight: number;
  llmAssistMinConfidence: number;
  llmSummaryPromptVersion: string;
  llmFallbackAlertEnabled: boolean;
  warnings: string[];
}
