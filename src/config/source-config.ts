import fs from "node:fs/promises";

import { z } from "zod";
import YAML from "yaml";

import type { SourceConfig } from "../core/types.js";

const sourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.literal("rss"),
  url: z.string().url(),
  language: z.enum(["zh", "en", "mixed"]),
  weight: z.number().min(1).max(100),
  enabled: z.boolean(),
});

const sourceListSchema = z.array(sourceSchema).min(1);

export async function loadSourceConfig(path: string): Promise<SourceConfig[]> {
  const content = await fs.readFile(path, "utf-8");
  const parsed = YAML.parse(content);
  return sourceListSchema.parse(parsed);
}
