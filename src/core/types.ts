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
  useMock: boolean;
  sourceConfigPath: string;
  sourceLimit: number;
  rawItems: RawItem[];
  items: NormalizedItem[];
  rankedItems: RankedItem[];
  highlights: RankedItem[];
  reportMarkdown: string;
  metrics: PipelineMetrics;
  warnings: string[];
}
