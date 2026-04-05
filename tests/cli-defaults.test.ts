import { describe, expect, it, vi } from "vitest";

describe("cli defaults", () => {
  it("应从 env 覆盖 runtime 路径默认值", async () => {
    vi.stubEnv("RUNTIME_CONFIG_PATH", "/tmp/runtime/runtime-config/global.json");
    vi.stubEnv("STORAGE_DB_PATH", "/tmp/runtime/db/app.sqlite");
    vi.stubEnv("REVIEW_INSTRUCTION_ROOT", "/tmp/runtime/review-instructions");
    vi.stubEnv("WATCH_LOCK_FILE", "/tmp/runtime/watchdog/weekly.lock");
    vi.stubEnv("WATCH_SUMMARY_ROOT", "/tmp/runtime/watchdog");
    vi.stubEnv("NOTIFICATION_ROOT", "/tmp/runtime/notifications/feishu");

    const { __test__ } = await import("../src/cli.js");
    const defaults = __test__.defaults();

    expect(defaults.runtimeConfigPath).toBe("/tmp/runtime/runtime-config/global.json");
    expect(defaults.storageDbPath).toBe("/tmp/runtime/db/app.sqlite");
    expect(defaults.reviewInstructionRoot).toBe("/tmp/runtime/review-instructions");
    expect(defaults.watchLockFile).toBe("/tmp/runtime/watchdog/weekly.lock");
    expect(defaults.watchSummaryRoot).toBe("/tmp/runtime/watchdog");
    expect(defaults.notificationRoot).toBe("/tmp/runtime/notifications/feishu");

    vi.unstubAllEnvs();
  });
});
