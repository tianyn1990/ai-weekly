import { describe, expect, it } from "vitest";

import { buildManualOperationDedupeKey, buildManualRestartOperationDedupeKey } from "../src/daemon/operation-dedupe.js";

describe("buildManualOperationDedupeKey", () => {
  it("应按 operation + reportDate 生成稳定去重键", () => {
    const key = buildManualOperationDedupeKey({
      operation: "run_weekly",
      reportDate: "2026-03-08",
    });
    expect(key).toBe("manual_op:run_weekly:2026-03-08");
  });

  it("同一天同动作应生成同一个 key（用于屏蔽重复回调）", () => {
    const a = buildManualOperationDedupeKey({
      operation: "run_weekly",
      reportDate: "2026-03-08",
    });
    const b = buildManualOperationDedupeKey({
      operation: "run_weekly",
      reportDate: "2026-03-08",
    });
    expect(a).toBe(b);
  });
});

describe("buildManualRestartOperationDedupeKey", () => {
  it("应按 operation + reportDate 生成稳定重启去重键", () => {
    const key = buildManualRestartOperationDedupeKey({
      operation: "run_weekly",
      reportDate: "2026-03-11",
    });
    expect(key).toBe("manual_restart:run_weekly:2026-03-11");
  });

  it("同一天同动作多次点击应命中同一重启 key", () => {
    const a = buildManualRestartOperationDedupeKey({
      operation: "run_weekly",
      reportDate: "2026-03-11",
    });
    const b = buildManualRestartOperationDedupeKey({
      operation: "run_weekly",
      reportDate: "2026-03-11",
    });
    expect(a).toBe(b);
  });
});
