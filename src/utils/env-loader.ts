import fs from "node:fs/promises";
import path from "node:path";

export interface LoadProjectEnvOptions {
  cwd?: string;
  envFilePath?: string;
  override?: boolean;
}

export interface LoadProjectEnvResult {
  loaded: boolean;
  filePath: string;
  count: number;
}

/**
 * 统一加载项目级环境变量，默认使用 `.env.local` 并覆盖同名全局变量，
 * 防止 shell 历史导出的变量污染当前仓库运行结果。
 */
export async function loadProjectEnv(options: LoadProjectEnvOptions = {}): Promise<LoadProjectEnvResult> {
  const cwd = options.cwd ?? process.cwd();
  const filePath = options.envFilePath ?? process.env.AI_WEEKLY_ENV_FILE ?? path.join(cwd, ".env.local");
  const override = options.override ?? true;

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { loaded: false, filePath, count: 0 };
    }
    throw error;
  }

  const parsed = parseEnvFile(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (!override && process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
  }

  return { loaded: true, filePath, count: Object.keys(parsed).length };
}

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const valueRaw = line.slice(index + 1).trim();
    if (!key) {
      continue;
    }
    result[key] = parseEnvValue(valueRaw);
  }
  return result;
}

function parseEnvValue(input: string): string {
  if (input.length === 0) {
    return "";
  }

  if ((input.startsWith("\"") && input.endsWith("\"")) || (input.startsWith("'") && input.endsWith("'"))) {
    return input.slice(1, -1);
  }

  const hashIndex = input.indexOf(" #");
  if (hashIndex > 0) {
    return input.slice(0, hashIndex).trim();
  }
  return input;
}

export const __test__ = {
  parseEnvValue,
};

