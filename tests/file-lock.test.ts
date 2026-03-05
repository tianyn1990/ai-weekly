import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { acquireFileLock } from "../src/utils/file-lock.js";

describe("file-lock", () => {
  it("同一锁路径应只允许一个持有者", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-lock-"));
    const lockPath = path.join(tempDir, "watchdog.lock");

    const first = await acquireFileLock(lockPath);
    await expect(acquireFileLock(lockPath)).rejects.toThrow("watchdog_lock_exists");

    await first.release();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("forceUnlock=true 时应允许替换残留锁", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-lock-"));
    const lockPath = path.join(tempDir, "watchdog.lock");

    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "stale-lock", "utf-8");

    const lock = await acquireFileLock(lockPath, { forceUnlock: true });
    await lock.release();

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});

