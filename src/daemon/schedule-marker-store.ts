import fs from "node:fs/promises";
import path from "node:path";

export class FileScheduleMarkerStore {
  constructor(private readonly rootDir: string) {}

  async has(markerKey: string): Promise<boolean> {
    try {
      await fs.access(this.getPath(markerKey));
      return true;
    } catch {
      return false;
    }
  }

  async mark(markerKey: string, payload?: Record<string, unknown>): Promise<void> {
    const filePath = this.getPath(markerKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          markerKey,
          markedAt: new Date().toISOString(),
          ...(payload ? { payload } : {}),
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  async listMarkerKeys(): Promise<Set<string>> {
    const keys = new Set<string>();
    await walkDir(this.rootDir, (filePath) => {
      if (!filePath.endsWith(".json")) {
        return;
      }
      const basename = path.basename(filePath, ".json");
      keys.add(decodeURIComponent(basename));
    });
    return keys;
  }

  private getPath(markerKey: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(markerKey)}.json`);
  }
}

async function walkDir(root: string, onFile: (filePath: string) => void): Promise<void> {
  let entries: Array<import("node:fs").Dirent> = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath, onFile);
      continue;
    }
    onFile(fullPath);
  }
}
