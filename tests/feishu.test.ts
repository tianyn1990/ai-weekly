import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FeishuNotifier, __test__, startFeishuReviewCallbackServer } from "../src/review/feishu.js";
import { FileReviewInstructionStore } from "../src/review/instruction-store.js";

describe("FeishuNotifier", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("发送待审核通知时应调用 webhook", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const notifier = new FeishuNotifier({
      webhookUrl: "https://example.com/feishu-webhook",
      webhookSecret: undefined,
    });

    const sent = await notifier.notifyReviewPending({
      reportDate: "2026-03-09",
      reviewStage: "outline_review",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      reviewMarkdownPath: "outputs/review/weekly/2026-03-09.md",
    });

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://example.com/feishu-webhook");
    const body = JSON.parse(String(options?.body));
    expect(body.msg_type).toBe("text");
    expect(body.content.text).toContain("2026-03-09");
  });

  it("配置 webhook secret 时应生成 sign 字段", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-05T01:02:03.000Z"));
    const body = __test__.buildWebhookBody("hello", "secret");
    vi.useRealTimers();

    const expectedTimestamp = String(Math.floor(new Date("2026-03-05T01:02:03.000Z").getTime() / 1000));
    const expectedSign = crypto.createHmac("sha256", `${expectedTimestamp}\nsecret`).digest("base64");
    expect(body.timestamp).toBe(expectedTimestamp);
    expect(body.sign).toBe(expectedSign);
  });

  it("飞书业务码非 0 时应抛错", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 19021, msg: "sign match fail" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const notifier = new FeishuNotifier({
      webhookUrl: "https://example.com/feishu-webhook",
      webhookSecret: "secret",
    });

    await expect(
      notifier.notifyReviewPending({
        reportDate: "2026-03-09",
        reviewStage: "outline_review",
        reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
        reviewMarkdownPath: "outputs/review/weekly/2026-03-09.md",
      }),
    ).rejects.toThrow("feishu_webhook_business_failed:19021");
  });
});

describe("Feishu callback server", () => {
  it("应在鉴权通过后写入审核指令文件", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-"));
    try {
      const store = new FileReviewInstructionStore(tempDir);
      const server = await startFeishuReviewCallbackServer({
        host: "127.0.0.1",
        port: 0,
        path: "/feishu/review-callback",
        authToken: "token-123",
        store,
      });

      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/feishu/review-callback`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer token-123",
          },
          body: JSON.stringify({
            mode: "weekly",
            reportDate: "2026-03-09",
            action: "approve_outline",
            operator: "u_001",
            messageId: "msg_1",
          }),
        });
        expect(response.status).toBe(200);

        const instructionFile = path.join(tempDir, "weekly", "2026-03-09.json");
        const content = JSON.parse(await fs.readFile(instructionFile, "utf-8"));
        expect(content.instructions).toHaveLength(1);
        expect(content.instructions[0].source).toBe("feishu_callback");
        expect(content.instructions[0].action).toBe("approve_outline");
      } finally {
        await server.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("鉴权失败时应返回 401", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-"));
    try {
      const store = new FileReviewInstructionStore(tempDir);
      const server = await startFeishuReviewCallbackServer({
        host: "127.0.0.1",
        port: 0,
        path: "/feishu/review-callback",
        authToken: "token-123",
        store,
      });

      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/feishu/review-callback`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "weekly",
            reportDate: "2026-03-09",
            action: "approve_outline",
          }),
        });
        expect(response.status).toBe(401);
      } finally {
        await server.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
