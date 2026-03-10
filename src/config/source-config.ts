import fs from "node:fs/promises";

import { z } from "zod";
import YAML from "yaml";

import type { SourceConfig } from "../core/types.js";

const baseSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  language: z.enum(["zh", "en", "mixed"]),
  weight: z.number().min(1).max(100),
  enabled: z.boolean(),
});

const rssSourceSchema = baseSourceSchema.extend({
  type: z.literal("rss"),
  url: z.string().url(),
});

const githubSearchSourceSchema = baseSourceSchema.extend({
  type: z.literal("github_search"),
  query: z.string().min(1),
  // GitHub Search 的排序字段有限，先做白名单约束防止配置拼写错误导致静默降级。
  sort: z.enum(["stars", "forks", "updated"]).optional().default("updated"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
  perPage: z.number().int().min(1).max(100).optional().default(10),
});

const sourceSchema = z.discriminatedUnion("type", [rssSourceSchema, githubSearchSourceSchema]);
const sourceListSchema = z.array(sourceSchema).min(1);

export async function loadSourceConfig(path: string): Promise<SourceConfig[]> {
  const content = await fs.readFile(path, "utf-8");
  const parsed = YAML.parse(content);
  return sourceListSchema.parse(parsed);
}
