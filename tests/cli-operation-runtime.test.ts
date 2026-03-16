import { describe, expect, it, vi } from "vitest";

import { __test__ } from "../src/cli.js";

describe("cli operation runtime helpers", () => {
  it("应识别需要通知的飞书任务来源", () => {
    expect(__test__.shouldNotifyFeishuJobSource("feishu_manual")).toBe(true);
    expect(__test__.shouldNotifyFeishuJobSource("feishu_callback_auto")).toBe(true);
    expect(__test__.shouldNotifyFeishuJobSource("scheduler")).toBe(false);
    expect(__test__.shouldNotifyFeishuJobSource(undefined)).toBe(false);
  });

  it("失败分类应识别 subprocess_timeout", () => {
    const classified = __test__.classifyOperationFailure("subprocess_timeout:600000ms");
    expect(classified.category).toBe("subprocess_timeout");
  });

  it("冲突通知判定：同 jobId 的重复回调不应触发冲突", () => {
    expect(
      __test__.shouldNotifyOperationConflict(
        {
          id: 75,
          status: "running",
        },
        75,
      ),
    ).toBe(false);
  });

  it("冲突通知判定：仅当命中其他活跃任务时才触发冲突", () => {
    expect(
      __test__.shouldNotifyOperationConflict(
        {
          id: 76,
          status: "running",
        },
        75,
      ),
    ).toBe(true);
    expect(
      __test__.shouldNotifyOperationConflict(
        {
          id: 76,
          status: "success",
        },
        75,
      ),
    ).toBe(false);
  });

  it("子进程超过 wall-clock 阈值应抛出 subprocess_timeout", async () => {
    const jobStore = {
      isCancelRequested: vi.fn(async () => false),
    };

    await expect(
      __test__.runQueuedCliSubprocess({
        args: {} as any,
        jobStore: jobStore as any,
        jobId: 1,
        // 这里直接启动一个长时间空转进程，避免依赖业务 CLI 逻辑即可稳定命中 timeout 分支。
        cliArgs: ["-e", "setTimeout(() => {}, 2000)"],
        maxWallClockMs: 50,
      }),
    ).rejects.toThrow(/subprocess_timeout/);
  });

  it("入口判定：导入场景不应被当作 CLI 主入口", () => {
    expect(__test__.isCliEntrypoint("file:///a/cli.ts", undefined)).toBe(false);
    expect(__test__.isCliEntrypoint("file:///a/cli.ts", "/b/cli.ts")).toBe(false);
  });
});
