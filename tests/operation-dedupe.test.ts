import { describe, expect, it } from "vitest";

import { buildManualOperationDedupeKey } from "../src/daemon/operation-dedupe.js";

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
