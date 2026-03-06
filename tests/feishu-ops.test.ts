import { describe, expect, it } from "vitest";

import { __test__ } from "../src/tools/feishu-ops.js";

describe("feishu-ops parseArgs", () => {
  it("应解析 token 子命令", () => {
    const args = __test__.parseArgs(["token"]);
    expect(args.command).toBe("token");
  });

  it("应解析 chats 子命令与 chat-name", () => {
    const args = __test__.parseArgs(["chats", "--chat-name", "AI 周报"]);
    expect(args.command).toBe("chats");
    expect(args.chatName).toBe("AI 周报");
  });

  it("应解析 send-card 参数", () => {
    const args = __test__.parseArgs([
      "send-card",
      "--chat-id",
      "oc_xxx",
      "--report-date",
      "2026-03-09",
      "--title",
      "title",
    ]);
    expect(args.command).toBe("send-card");
    expect(args.chatId).toBe("oc_xxx");
    expect(args.reportDate).toBe("2026-03-09");
    expect(args.title).toBe("title");
  });

  it("非法子命令应抛错", () => {
    expect(() => __test__.parseArgs(["unknown"])).toThrow("未知子命令");
  });
});

describe("feishu-ops buildReviewCard", () => {
  it("应生成包含四个审核动作的卡片", () => {
    const card = __test__.buildReviewCard({
      reportDate: "2026-03-09",
      title: "AI 周报审核 2026-03-09",
    });
    const actions = (card.elements[1] as { actions: Array<{ value: { action: string } }> }).actions;
    expect(actions.map((item) => item.value.action)).toEqual([
      "approve_outline",
      "approve_final",
      "request_revision",
      "reject",
    ]);
  });
});
