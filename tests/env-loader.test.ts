import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { __test__, loadProjectEnv, parseEnvFile } from "../src/utils/env-loader.js";

describe("env-loader", () => {
  const touchedKeys = new Set<string>();

  afterEach(() => {
    for (const key of touchedKeys) {
      delete process.env[key];
    }
    touchedKeys.clear();
  });

  it("应解析注释、引号与空值", () => {
    const parsed = parseEnvFile(
      [
        "# comment",
        "FOO=bar",
        "BAR=\"quoted value\"",
        "BAZ='single quoted'",
        "EMPTY=",
        "WITH_COMMENT=value # tail",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      FOO: "bar",
      BAR: "quoted value",
      BAZ: "single quoted",
      EMPTY: "",
      WITH_COMMENT: "value",
    });
    expect(__test__.parseEnvValue("\"x\"")).toBe("x");
  });

  it("override=true 时应覆盖已有环境变量", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-env-"));
    const envPath = path.join(dir, ".env.local");
    await fs.writeFile(envPath, "ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic\n", "utf-8");

    process.env.ANTHROPIC_BASE_URL = "https://bad.example.com";
    touchedKeys.add("ANTHROPIC_BASE_URL");

    const result = await loadProjectEnv({
      envFilePath: envPath,
      override: true,
    });

    expect(result.loaded).toBe(true);
    expect(process.env.ANTHROPIC_BASE_URL).toBe("https://api.minimaxi.com/anthropic");
  });

  it("override=false 时不应覆盖已有环境变量", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-env-"));
    const envPath = path.join(dir, ".env.local");
    await fs.writeFile(envPath, "MINIMAX_API_KEY=from_file\n", "utf-8");

    process.env.MINIMAX_API_KEY = "from_process";
    touchedKeys.add("MINIMAX_API_KEY");

    await loadProjectEnv({
      envFilePath: envPath,
      override: false,
    });

    expect(process.env.MINIMAX_API_KEY).toBe("from_process");
  });
});

