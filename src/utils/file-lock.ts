import fs from "node:fs/promises";
import path from "node:path";

export interface FileLock {
  release: () => Promise<void>;
}

export async function acquireFileLock(lockPath: string, options?: { forceUnlock?: boolean }): Promise<FileLock> {
  if (options?.forceUnlock) {
    await fs.rm(lockPath, { force: true });
  }

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  let handle;
  try {
    // 使用 wx 原子创建锁文件，避免并发实例重复进入关键流程。
    handle = await fs.open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`watchdog_lock_exists:${lockPath}`);
    }
    throw error;
  }

  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2), "utf-8");

  let released = false;
  return {
    async release() {
      if (released) {
        return;
      }

      released = true;
      await handle.close();
      await fs.rm(lockPath, { force: true });
    },
  };
}

