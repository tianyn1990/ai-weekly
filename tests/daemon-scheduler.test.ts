import { describe, expect, it } from "vitest";

import { computeDueScheduledJobs } from "../src/daemon/scheduler.js";

describe("computeDueScheduledJobs", () => {
  it("周一 12:31 后应产出 weekly run/reminder/watchdog 与 daily run", () => {
    const due = computeDueScheduledJobs({
      nowIso: "2026-03-09T04:31:00.000Z", // 2026-03-09 12:31 Asia/Shanghai
      timezoneName: "Asia/Shanghai",
      alreadyTriggered: new Set<string>(),
    });

    const keys = due.map((item) => item.markerKey);
    expect(keys).toContain("daily_run:2026-03-09");
    expect(keys).toContain("weekly_run:2026-03-09");
    expect(keys).toContain("weekly_reminder:2026-03-09");
    expect(keys).toContain("weekly_watchdog:2026-03-09");
  });

  it("已触发 marker 不应重复产出", () => {
    const due = computeDueScheduledJobs({
      nowIso: "2026-03-09T04:31:00.000Z",
      timezoneName: "Asia/Shanghai",
      alreadyTriggered: new Set<string>(["weekly_run:2026-03-09", "weekly_watchdog:2026-03-09"]),
    });

    const keys = due.map((item) => item.markerKey);
    expect(keys).not.toContain("weekly_run:2026-03-09");
    expect(keys).not.toContain("weekly_watchdog:2026-03-09");
    expect(keys).toContain("weekly_reminder:2026-03-09");
  });

  it("非周一仅触发 daily 任务", () => {
    const due = computeDueScheduledJobs({
      nowIso: "2026-03-10T01:10:00.000Z", // Tue 09:10
      timezoneName: "Asia/Shanghai",
      alreadyTriggered: new Set<string>(),
    });

    const keys = due.map((item) => item.markerKey);
    expect(keys).toEqual(["daily_run:2026-03-10"]);
  });
});
