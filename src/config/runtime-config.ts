import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { DbAuditStore } from "../audit/audit-store.js";
import type { RankingWeightDimension, ReviewFeedbackPayload, SourceConfig } from "../core/types.js";
import { SqliteEngine } from "../storage/sqlite-engine.js";

const rankingWeightsSchema = z.object({
  source: z.number().min(0).max(3),
  freshness: z.number().min(0).max(3),
  keyword: z.number().min(0).max(3),
});

const runtimeConfigSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  topics: z.array(z.string().min(1)),
  searchTerms: z.array(z.string().min(1)),
  sourceToggles: z.record(z.string().min(1), z.boolean()),
  sourceWeights: z.record(z.string().min(1), z.number().min(1).max(100)),
  rankingWeights: rankingWeightsSchema,
});

const runtimeConfigVersionRowSchema = z.object({
  version: z.number(),
  payload_json: z.string(),
  updated_at: z.string(),
  updated_by: z.string().nullable().optional(),
  trace_id: z.string().nullable().optional(),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export interface RuntimeConfigMergeResult {
  config: RuntimeConfig;
  changedKeys: string[];
}

export interface RuntimeConfigRecord {
  version: number;
  config: RuntimeConfig;
  updatedAt: string;
  updatedBy?: string;
  traceId?: string;
}

export interface RuntimeConfigStore {
  getCurrent(): Promise<RuntimeConfigRecord>;
  saveNext(input: {
    config: RuntimeConfig;
    updatedAt: string;
    updatedBy?: string;
    traceId?: string;
    expectedVersion?: number;
  }): Promise<RuntimeConfigRecord>;
}

export interface CreateRuntimeConfigStoreInput {
  backend: "file" | "db";
  filePath: string;
  dbPath: string;
  fallbackToFile: boolean;
}

export class RuntimeConfigVersionConflictError extends Error {
  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`runtime_config_version_conflict:expected=${expectedVersion},actual=${actualVersion}`);
    this.name = "RuntimeConfigVersionConflictError";
  }
}

export function createDefaultRuntimeConfig(nowIso = new Date().toISOString()): RuntimeConfig {
  return {
    version: 1,
    updatedAt: nowIso,
    topics: [],
    searchTerms: [],
    sourceToggles: {},
    sourceWeights: {},
    rankingWeights: {
      source: 1,
      freshness: 1,
      keyword: 1,
    },
  };
}

export function createRuntimeConfigStore(input: CreateRuntimeConfigStoreInput): RuntimeConfigStore {
  const fileStore = new FileRuntimeConfigStore(input.filePath);
  if (input.backend === "file") {
    return fileStore;
  }

  const dbStore = new DbRuntimeConfigStore(new SqliteEngine(input.dbPath));
  if (!input.fallbackToFile) {
    return dbStore;
  }

  return new HybridRuntimeConfigStore({
    primary: dbStore,
    fallback: fileStore,
  });
}

// 为兼容历史代码路径，保留文件模式的 load/save 方法。
export async function loadRuntimeConfig(configPath: string): Promise<RuntimeConfig> {
  const store = new FileRuntimeConfigStore(configPath);
  const current = await store.getCurrent();
  return current.config;
}

export async function saveRuntimeConfig(configPath: string, config: RuntimeConfig): Promise<void> {
  const store = new FileRuntimeConfigStore(configPath);
  await store.saveNext({
    config,
    updatedAt: config.updatedAt,
  });
}

export async function loadRuntimeConfigByStore(input: CreateRuntimeConfigStoreInput): Promise<RuntimeConfigRecord> {
  return createRuntimeConfigStore(input).getCurrent();
}

export async function saveRuntimeConfigByStore(
  storeInput: CreateRuntimeConfigStoreInput,
  input: {
    config: RuntimeConfig;
    updatedAt: string;
    updatedBy?: string;
    traceId?: string;
    expectedVersion?: number;
  },
): Promise<RuntimeConfigRecord> {
  const store = createRuntimeConfigStore(storeInput);
  return store.saveNext(input);
}

export function applyRuntimeSourceOverrides(sources: SourceConfig[], config: RuntimeConfig): SourceConfig[] {
  return sources.map((source) => {
    const enabled = config.sourceToggles[source.id] ?? source.enabled;
    const adjustedWeight = config.sourceWeights[source.id] ?? source.weight;
    return {
      ...source,
      enabled,
      weight: adjustedWeight,
    };
  });
}

export function mergeRuntimeConfigByFeedback(input: {
  current: RuntimeConfig;
  feedback: ReviewFeedbackPayload;
  nowIso: string;
}): RuntimeConfigMergeResult {
  const { current, feedback, nowIso } = input;
  const next: RuntimeConfig = JSON.parse(JSON.stringify(current)) as RuntimeConfig;
  const changedKeys = new Set<string>();

  if (feedback.newTopics && feedback.newTopics.length > 0) {
    next.topics = mergeUniqueStrings(next.topics, feedback.newTopics);
    changedKeys.add("topics");
  }

  if (feedback.newSearchTerms && feedback.newSearchTerms.length > 0) {
    next.searchTerms = mergeUniqueStrings(next.searchTerms, feedback.newSearchTerms);
    changedKeys.add("searchTerms");
  }

  if (feedback.sourceToggles && feedback.sourceToggles.length > 0) {
    for (const entry of feedback.sourceToggles) {
      next.sourceToggles[entry.sourceId] = entry.enabled;
    }
    changedKeys.add("sourceToggles");
  }

  if (feedback.sourceWeightAdjustments && feedback.sourceWeightAdjustments.length > 0) {
    for (const entry of feedback.sourceWeightAdjustments) {
      next.sourceWeights[entry.sourceId] = entry.weight;
    }
    changedKeys.add("sourceWeights");
  }

  if (feedback.rankingWeightAdjustments && feedback.rankingWeightAdjustments.length > 0) {
    for (const entry of feedback.rankingWeightAdjustments) {
      setRankingWeight(next.rankingWeights, entry.dimension, entry.weight);
    }
    changedKeys.add("rankingWeights");
  }

  next.updatedAt = nowIso;
  return {
    config: runtimeConfigSchema.parse(next),
    changedKeys: Array.from(changedKeys.values()),
  };
}

export class FileRuntimeConfigStore implements RuntimeConfigStore {
  constructor(private readonly configPath: string) {}

  async getCurrent(): Promise<RuntimeConfigRecord> {
    try {
      const content = await fs.readFile(this.configPath, "utf-8");
      const parsed = runtimeConfigSchema.parse(JSON.parse(content));
      return {
        version: 0,
        config: parsed,
        updatedAt: parsed.updatedAt,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const fallback = createDefaultRuntimeConfig();
        return {
          version: 0,
          config: fallback,
          updatedAt: fallback.updatedAt,
        };
      }
      throw error;
    }
  }

  async saveNext(input: {
    config: RuntimeConfig;
    updatedAt: string;
    updatedBy?: string;
    traceId?: string;
    expectedVersion?: number;
  }): Promise<RuntimeConfigRecord> {
    const normalized = runtimeConfigSchema.parse(input.config);
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(normalized, null, 2), "utf-8");

    return {
      version: 0,
      config: normalized,
      updatedAt: normalized.updatedAt,
      updatedBy: input.updatedBy,
      traceId: input.traceId,
    };
  }
}

export class DbRuntimeConfigStore implements RuntimeConfigStore {
  private readonly auditStore: DbAuditStore;

  constructor(private readonly engine: SqliteEngine) {
    this.auditStore = new DbAuditStore(engine);
  }

  async getCurrent(): Promise<RuntimeConfigRecord> {
    return this.engine.read((ctx) => {
      const row = ctx.queryOne(
        `
        SELECT version, payload_json, updated_at, updated_by, trace_id
        FROM runtime_config_versions
        ORDER BY version DESC
        LIMIT 1;
        `,
      );

      if (!row) {
        const fallback = createDefaultRuntimeConfig();
        return {
          version: 0,
          config: fallback,
          updatedAt: fallback.updatedAt,
        };
      }

      return toRuntimeConfigRecord(runtimeConfigVersionRowSchema.parse(row));
    });
  }

  async saveNext(input: {
    config: RuntimeConfig;
    updatedAt: string;
    updatedBy?: string;
    traceId?: string;
    expectedVersion?: number;
  }): Promise<RuntimeConfigRecord> {
    const normalized = runtimeConfigSchema.parse(input.config);
    const nowIso = input.updatedAt;

    const saved = await this.engine.write((ctx) => {
      const current = ctx.queryOne<{ version: number }>(
        `
        SELECT version
        FROM runtime_config_versions
        ORDER BY version DESC
        LIMIT 1;
        `,
      );
      const currentVersion = current?.version ?? 0;
      if (typeof input.expectedVersion === "number" && input.expectedVersion !== currentVersion) {
        throw new RuntimeConfigVersionConflictError(input.expectedVersion, currentVersion);
      }

      const nextVersion = currentVersion + 1;
      ctx.run(
        `
        INSERT INTO runtime_config_versions (
          version, payload_json, updated_at, updated_by, trace_id
        ) VALUES (
          $version, $payloadJson, $updatedAt, $updatedBy, $traceId
        );
        `,
        {
          $version: nextVersion,
          $payloadJson: JSON.stringify(normalized),
          $updatedAt: nowIso,
          $updatedBy: input.updatedBy ?? null,
          $traceId: input.traceId ?? null,
        },
      );

      return {
        version: nextVersion,
        config: normalized,
        updatedAt: nowIso,
        updatedBy: input.updatedBy,
        traceId: input.traceId,
      };
    });

    // 配置写入后补充审计事件，方便定位是谁在何时修改了全局策略。
    await this.auditStore.append({
      eventType: "runtime_config_saved",
      entityType: "runtime_config",
      entityId: String(saved.version),
      payload: {
        version: saved.version,
        updatedAt: saved.updatedAt,
      },
      operator: input.updatedBy,
      source: "api",
      traceId: input.traceId,
      createdAt: nowIso,
    });

    return saved;
  }
}

class HybridRuntimeConfigStore implements RuntimeConfigStore {
  constructor(
    private readonly input: {
      primary: RuntimeConfigStore;
      fallback: RuntimeConfigStore;
    },
  ) {}

  async getCurrent(): Promise<RuntimeConfigRecord> {
    try {
      return await this.input.primary.getCurrent();
    } catch {
      return this.input.fallback.getCurrent();
    }
  }

  async saveNext(input: {
    config: RuntimeConfig;
    updatedAt: string;
    updatedBy?: string;
    traceId?: string;
    expectedVersion?: number;
  }): Promise<RuntimeConfigRecord> {
    const saved = await this.input.primary.saveNext(input);
    try {
      await this.input.fallback.saveNext({
        config: input.config,
        updatedAt: input.updatedAt,
        updatedBy: input.updatedBy,
        traceId: input.traceId,
      });
    } catch {
      // no-op
    }
    return saved;
  }
}

function toRuntimeConfigRecord(row: z.infer<typeof runtimeConfigVersionRowSchema>): RuntimeConfigRecord {
  return {
    version: row.version,
    config: runtimeConfigSchema.parse(JSON.parse(row.payload_json)),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? undefined,
    traceId: row.trace_id ?? undefined,
  };
}

function setRankingWeight(target: RuntimeConfig["rankingWeights"], dimension: RankingWeightDimension, weight: number) {
  if (dimension === "source") {
    target.source = weight;
    return;
  }
  if (dimension === "freshness") {
    target.freshness = weight;
    return;
  }
  target.keyword = weight;
}

function mergeUniqueStrings(base: string[], additions: string[]): string[] {
  const set = new Set(base.map((value) => value.trim()).filter((value) => value.length > 0));
  for (const value of additions) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    set.add(normalized);
  }
  return Array.from(set.values());
}
