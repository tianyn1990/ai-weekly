import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FeishuNotifier, __test__, startFeishuReviewCallbackServer } from "../src/review/feishu.js";
import { FileReviewInstructionStore } from "../src/review/instruction-store.js";

describe("FeishuNotifier", () => {
  afterEach(() => {
    __test__.clearTenantTokenCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("发送待审核通知时应调用应用机器人消息接口", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-notifier-"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant_token", expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: "om_xxx" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const notifier = new FeishuNotifier({
      appId: "cli_xxx",
      appSecret: "secret_xxx",
      reviewChatId: "oc_xxx",
      notificationRoot: tempDir,
    });

    const sent = await notifier.notifyReviewPending({
      runId: "weekly-run-1",
      reportDate: "2026-03-09",
      reviewStage: "outline_review",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      reviewMarkdownPath: "outputs/review/weekly/2026-03-09.md",
    });

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/auth/v3/tenant_access_token/internal");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/im/v1/messages");
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body.msg_type).toBe("interactive");
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("应用机器人业务码非 0 时应抛错", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-notifier-"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant_token", expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 999, msg: "no permission" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const notifier = new FeishuNotifier({
      appId: "cli_xxx",
      appSecret: "secret_xxx",
      reviewChatId: "oc_xxx",
      notificationRoot: tempDir,
    });

    await expect(
      notifier.notifyReviewPending({
        runId: "weekly-run-1",
        reportDate: "2026-03-09",
        reviewStage: "outline_review",
        reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
        reviewMarkdownPath: "outputs/review/weekly/2026-03-09.md",
      }),
    ).rejects.toThrow("feishu_app_card_business_failed:999");
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("应支持通过 REPORT_PUBLIC_BASE_URL 生成可点击 URL", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-notifier-"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant_token", expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: "om_xxx" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const notifier = new FeishuNotifier({
      appId: "cli_xxx",
      appSecret: "secret_xxx",
      reviewChatId: "oc_xxx",
      reportPublicBaseUrl: "https://raw.githubusercontent.com/acme/ai-weekly/main",
      notificationRoot: tempDir,
    });

    const sent = await notifier.notifyReviewPending({
      runId: "weekly-run-1",
      reportDate: "2026-03-09",
      reviewStage: "outline_review",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      reviewMarkdownPath: "outputs/review/weekly/2026-03-09.md",
    });
    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const card = JSON.parse(body.content) as { elements: Array<{ tag: string; content?: string }> };
    const markdown = card.elements.find((item) => item.tag === "markdown")?.content ?? "";
    expect(markdown).toContain(
      "[查看待审核稿](https://raw.githubusercontent.com/acme/ai-weekly/main/outputs/review/weekly/2026-03-09.md)",
    );
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("当 base 已包含 outputs 前缀时不应重复拼接 outputs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-notifier-"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant_token", expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: "om_xxx" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const notifier = new FeishuNotifier({
      appId: "cli_xxx",
      appSecret: "secret_xxx",
      reviewChatId: "oc_xxx",
      reportPublicBaseUrl: "https://raw.githubusercontent.com/acme/ai-weekly/main/outputs",
      notificationRoot: tempDir,
    });

    await notifier.notifyReviewPending({
      runId: "weekly-run-1",
      reportDate: "2026-03-09",
      reviewStage: "outline_review",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      reviewMarkdownPath: "outputs/review/weekly/2026-03-09.md",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const card = JSON.parse(body.content) as { elements: Array<{ tag: string; content?: string }> };
    const markdown = card.elements.find((item) => item.tag === "markdown")?.content ?? "";
    expect(markdown).toContain(
      "[查看待审核稿](https://raw.githubusercontent.com/acme/ai-weekly/main/outputs/review/weekly/2026-03-09.md)",
    );
    expect(markdown).not.toContain("/outputs/outputs/");
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("同一 run 再次待审核通知时应更新主卡而非重复新发", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-notifier-"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant_token", expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: "om_first" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: "om_first" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const notifier = new FeishuNotifier({
      appId: "cli_xxx",
      appSecret: "secret_xxx",
      reviewChatId: "oc_xxx",
      notificationRoot: tempDir,
    });
    await notifier.notifyReviewPending({
      runId: "weekly-run-1",
      reportDate: "2026-03-09",
      reviewStage: "outline_review",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      reviewMarkdownPath: "outputs/review/weekly/2026-03-09.md",
    });
    await notifier.notifyReviewPending({
      runId: "weekly-run-1",
      reportDate: "2026-03-09",
      reviewStage: "final_review",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      reviewMarkdownPath: "outputs/review/weekly/2026-03-09.md",
    });

    // token + send，token 缓存后 update 主卡。
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/im/v1/messages/om_first");
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("待审核主卡应按阶段展示不同按钮集合", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-notifier-"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant_token", expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: "om_outline" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: "om_outline" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const notifier = new FeishuNotifier({
      appId: "cli_xxx",
      appSecret: "secret_xxx",
      reviewChatId: "oc_xxx",
      notificationRoot: tempDir,
    });

    await notifier.notifyReviewPending({
      runId: "weekly-run-1",
      reportDate: "2026-03-09",
      reviewStage: "outline_review",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      reviewMarkdownPath: "outputs/review/weekly/2026-03-09.md",
    });
    const outlineBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const outlineCard = JSON.parse(outlineBody.content) as { elements: Array<{ tag: string; actions?: Array<{ value?: { action?: string } }> }> };
    const outlineActions = outlineCard.elements.find((item) => item.tag === "action")?.actions ?? [];
    expect(outlineActions.map((item) => item.value?.action)).toEqual(["approve_outline", "request_revision", "reject"]);

    await notifier.notifyReviewPending({
      runId: "weekly-run-1",
      reportDate: "2026-03-09",
      reviewStage: "final_review",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      reviewMarkdownPath: "outputs/review/weekly/2026-03-09.md",
    });
    const finalBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    const finalCard = JSON.parse(finalBody.content) as { elements: Array<{ tag: string; actions?: Array<{ value?: { action?: string } }> }> };
    const finalActions = finalCard.elements.find((item) => item.tag === "action")?.actions ?? [];
    expect(finalActions.map((item) => item.value?.action)).toEqual(["approve_final", "request_revision", "reject"]);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("同一 run + 同一 stage 的短时间重复通知应跳过更新", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-notifier-"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant_token", expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: "om_outline" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const notifier = new FeishuNotifier({
      appId: "cli_xxx",
      appSecret: "secret_xxx",
      reviewChatId: "oc_xxx",
      notificationRoot: tempDir,
    });

    await notifier.notifyReviewPending({
      runId: "weekly-run-1",
      reportDate: "2026-03-09",
      reviewStage: "outline_review",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      reviewMarkdownPath: "outputs/review/weekly/2026-03-09.md",
    });
    await notifier.notifyReviewPending({
      runId: "weekly-run-1",
      reportDate: "2026-03-09",
      reviewStage: "outline_review",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      reviewMarkdownPath: "outputs/review/weekly/2026-03-09.md",
    });

    // token + 首次发卡；第二次同 stage 在短窗口内应 no-op，不再请求飞书。
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("主卡更新失败时应降级发送新卡并覆盖主卡记录", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-notifier-"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant_token", expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: "om_first" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 999, msg: "message expired" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: "om_second" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const notifier = new FeishuNotifier({
      appId: "cli_xxx",
      appSecret: "secret_xxx",
      reviewChatId: "oc_xxx",
      notificationRoot: tempDir,
    });

    await notifier.notifyReviewPending({
      runId: "weekly-run-1",
      reportDate: "2026-03-09",
      reviewStage: "outline_review",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      reviewMarkdownPath: "outputs/review/weekly/2026-03-09.md",
    });
    await notifier.notifyReviewPending({
      runId: "weekly-run-1",
      reportDate: "2026-03-09",
      reviewStage: "final_review",
      reviewDeadlineAt: "2026-03-09T04:30:00.000Z",
      reviewMarkdownPath: "outputs/review/weekly/2026-03-09.md",
    });

    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/im/v1/messages/om_first");
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain("/im/v1/messages?receive_id_type=chat_id");

    const recordFile = path.join(tempDir, "main-cards", "weekly", "2026-03-09.json");
    const record = JSON.parse(await fs.readFile(recordFile, "utf-8")) as { messageId: string; stage: string };
    expect(record.messageId).toBe("om_second");
    expect(record.stage).toBe("final_review");

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});

describe("Feishu callback server", () => {
  it("应支持 url_verification challenge 回包", async () => {
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
            type: "url_verification",
            challenge: "challenge-token",
          }),
        });
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.challenge).toBe("challenge-token");
      } finally {
        await server.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

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
        const responsePayload = await response.json();
        expect(responsePayload.toast?.type).toBe("success");

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
        const payload = await response.json();
        expect(payload.toast?.type).toBe("error");
      } finally {
        await server.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("应支持飞书卡片原生 payload（action.value）并写入指令", async () => {
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
        const response = await fetch(`http://127.0.0.1:${server.port}/feishu/review-callback?token=token-123`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            schema: "2.0",
            header: {
              event_id: "evt_1",
            },
            event: {
              create_time: "1709600000",
              operator: {
                open_id: "ou_xxx",
                name: "he tao",
              },
              action: {
                value: {
                  action: "approve_final",
                  reportDate: "2026-03-09",
                  reason: "looks good",
                  messageId: "msg_2",
                },
              },
            },
          }),
        });
        expect(response.status).toBe(200);

        const instructionFile = path.join(tempDir, "weekly", "2026-03-09.json");
        const content = JSON.parse(await fs.readFile(instructionFile, "utf-8"));
        expect(content.instructions).toHaveLength(1);
        expect(content.instructions[0].action).toBe("approve_final");
        expect(content.instructions[0].operator).toBe("he tao");
        expect(content.instructions[0].traceId).toBe("evt_1");
        expect(content.instructions[0].reason).toBe("looks good");
      } finally {
        await server.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("回调成功后应向 notifier 发送 accepted 回执", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-"));
    const actionNotifier = {
      notifyActionResult: vi.fn(async () => true),
    };

    try {
      const store = new FileReviewInstructionStore(tempDir);
      const server = await startFeishuReviewCallbackServer({
        host: "127.0.0.1",
        port: 0,
        path: "/feishu/review-callback",
        authToken: "token-123",
        store,
        notifier: actionNotifier,
      });

      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/feishu/review-callback?token=token-123`, {
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
        expect(response.status).toBe(200);
        expect(actionNotifier.notifyActionResult).toHaveBeenCalledTimes(1);
        expect(actionNotifier.notifyActionResult).toHaveBeenCalledWith(
          expect.objectContaining({
            reportDate: "2026-03-09",
            action: "approve_outline",
            result: "accepted",
          }),
        );
      } finally {
        await server.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("同一 traceId 重复回调时应忽略第二次并避免重复回执", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-"));
    const actionNotifier = {
      notifyActionResult: vi.fn(async () => true),
    };

    try {
      const store = new FileReviewInstructionStore(tempDir);
      const server = await startFeishuReviewCallbackServer({
        host: "127.0.0.1",
        port: 0,
        path: "/feishu/review-callback",
        authToken: "token-123",
        store,
        notifier: actionNotifier,
      });

      try {
        const payload = {
          mode: "weekly",
          reportDate: "2026-03-09",
          action: "approve_outline",
          traceId: "evt-dup-001",
          operator: "u_001",
        };

        const first = await fetch(`http://127.0.0.1:${server.port}/feishu/review-callback?token=token-123`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        expect(first.status).toBe(200);

        const second = await fetch(`http://127.0.0.1:${server.port}/feishu/review-callback?token=token-123`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        expect(second.status).toBe(200);
        const secondPayload = await second.json();
        expect(secondPayload.duplicated).toBe(true);

        const instructionFile = path.join(tempDir, "weekly", "2026-03-09.json");
        const content = JSON.parse(await fs.readFile(instructionFile, "utf-8"));
        expect(content.instructions).toHaveLength(1);
        expect(actionNotifier.notifyActionResult).toHaveBeenCalledTimes(1);
      } finally {
        await server.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("不同 traceId/messageId 但语义相同且短时间内重复时应忽略第二次", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-"));
    const actionNotifier = {
      notifyActionResult: vi.fn(async () => true),
    };

    try {
      const store = new FileReviewInstructionStore(tempDir);
      const server = await startFeishuReviewCallbackServer({
        host: "127.0.0.1",
        port: 0,
        path: "/feishu/review-callback",
        authToken: "token-123",
        store,
        notifier: actionNotifier,
      });

      try {
        const first = await fetch(`http://127.0.0.1:${server.port}/feishu/review-callback?token=token-123`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "weekly",
            reportDate: "2026-03-09",
            action: "approve_outline",
            stage: "outline_review",
            decidedAt: "2026-03-09T01:00:00.000Z",
            messageId: "om_msg_001",
          }),
        });
        expect(first.status).toBe(200);

        const second = await fetch(`http://127.0.0.1:${server.port}/feishu/review-callback?token=token-123`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "weekly",
            reportDate: "2026-03-09",
            action: "approve_outline",
            stage: "outline_review",
            decidedAt: "2026-03-09T01:00:30.000Z",
            traceId: "evt_trace_002",
            operator: "u_002",
          }),
        });
        expect(second.status).toBe(200);
        const secondPayload = await second.json();
        expect(secondPayload.duplicated).toBe(true);

        const instructionFile = path.join(tempDir, "weekly", "2026-03-09.json");
        const content = JSON.parse(await fs.readFile(instructionFile, "utf-8"));
        expect(content.instructions).toHaveLength(1);
        expect(actionNotifier.notifyActionResult).toHaveBeenCalledTimes(1);
      } finally {
        await server.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("回调处理后应写入审计事件（accepted）", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-"));
    const auditLogger = vi.fn(async () => undefined);
    try {
      const store = new FileReviewInstructionStore(tempDir);
      const server = await startFeishuReviewCallbackServer({
        host: "127.0.0.1",
        port: 0,
        path: "/feishu/review-callback",
        authToken: "token-123",
        store,
        auditLogger,
      });

      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/feishu/review-callback?token=token-123`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "weekly",
            reportDate: "2026-03-09",
            action: "approve_final",
          }),
        });
        expect(response.status).toBe(200);
        expect(auditLogger).toHaveBeenCalledTimes(1);
        expect(auditLogger).toHaveBeenCalledWith(
          expect.objectContaining({
            reportDate: "2026-03-09",
            action: "approve_final",
            result: "accepted",
            notifyResult: "skipped",
          }),
        );
      } finally {
        await server.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("回调鉴权失败时也应写入失败审计事件", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-"));
    const auditLogger = vi.fn(async () => undefined);
    try {
      const store = new FileReviewInstructionStore(tempDir);
      const server = await startFeishuReviewCallbackServer({
        host: "127.0.0.1",
        port: 0,
        path: "/feishu/review-callback",
        authToken: "token-123",
        store,
        auditLogger,
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
        expect(auditLogger).toHaveBeenCalledTimes(1);
        expect(auditLogger).toHaveBeenCalledWith(
          expect.objectContaining({
            reportDate: "2026-03-09",
            action: "approve_outline",
            result: "failed",
          }),
        );
      } finally {
        await server.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("应支持主动触发 operation 动作并走 operationHandler", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-"));
    const operationHandler = vi.fn(async () => ({
      accepted: true,
      message: "任务已入队",
      jobId: 101,
    }));
    try {
      const store = new FileReviewInstructionStore(tempDir);
      const server = await startFeishuReviewCallbackServer({
        host: "127.0.0.1",
        port: 0,
        path: "/feishu/review-callback",
        authToken: "token-123",
        store,
        operationHandler,
      });

      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/feishu/review-callback?token=token-123`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            event: {
              operator: {
                open_id: "ou_test",
              },
              action: {
                value: {
                  operation: "recheck_weekly",
                  reportDate: "2026-03-09",
                },
              },
            },
          }),
        });
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.ok).toBe(true);
        expect(payload.jobId).toBe(101);
        expect(operationHandler).toHaveBeenCalledTimes(1);
      } finally {
        await server.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("应支持 mention 事件并调用 mentionHandler", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-"));
    const mentionHandler = vi.fn(async () => ({
      handled: true,
      message: "已发送操作卡",
    }));
    try {
      const store = new FileReviewInstructionStore(tempDir);
      const server = await startFeishuReviewCallbackServer({
        host: "127.0.0.1",
        port: 0,
        path: "/feishu/review-callback",
        authToken: "token-123",
        store,
        mentionHandler,
      });

      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/feishu/review-callback?token=token-123`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            schema: "2.0",
            header: {
              event_type: "im.message.receive_v1",
              event_id: "evt_mention_001",
            },
            event: {
              operator: {
                open_id: "ou_test",
              },
              message: {
                message_type: "text",
                message_id: "om_001",
                chat_id: "oc_001",
                content: JSON.stringify({
                  text: "@机器人 请给我运维操作卡",
                }),
              },
            },
          }),
        });
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.ok).toBe(true);
        expect(mentionHandler).toHaveBeenCalledTimes(1);
      } finally {
        await server.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("重复 mention 回调应只处理一次并返回 duplicated", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-weekly-feishu-"));
    const mentionHandler = vi.fn(async () => ({
      handled: true,
      message: "已发送操作卡",
    }));
    try {
      const store = new FileReviewInstructionStore(tempDir);
      const server = await startFeishuReviewCallbackServer({
        host: "127.0.0.1",
        port: 0,
        path: "/feishu/review-callback",
        authToken: "token-123",
        store,
        mentionHandler,
      });

      try {
        const payload = {
          schema: "2.0",
          header: {
            event_type: "im.message.receive_v1",
            event_id: "evt_mention_dup_001",
          },
          event: {
            operator: {
              open_id: "ou_test",
            },
            message: {
              message_type: "text",
              message_id: "om_dup_001",
              chat_id: "oc_001",
              content: JSON.stringify({
                text: "@机器人 运维",
              }),
            },
          },
        };

        const first = await fetch(`http://127.0.0.1:${server.port}/feishu/review-callback?token=token-123`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        expect(first.status).toBe(200);

        const second = await fetch(`http://127.0.0.1:${server.port}/feishu/review-callback?token=token-123`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        expect(second.status).toBe(200);
        const secondPayload = await second.json();
        expect(secondPayload.duplicated).toBe(true);
        expect(mentionHandler).toHaveBeenCalledTimes(1);
      } finally {
        await server.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("Feishu callback payload adapter", () => {
  it("应解析 event.action.form_value 结构", () => {
    const parsed = __test__.parseCallbackBody(
      JSON.stringify({
        event: {
          operator_id: {
            open_id: "ou_test",
          },
          action: {
            form_value: {
              review_action: "request_revision",
              report_date: "2026-03-10",
              reason: "补充来源",
            },
          },
        },
      }),
    );

    if ("challenge" in parsed) {
      throw new Error("unexpected challenge");
    }
    expect(parsed.kind).toBe("review_action");
    if (parsed.kind !== "review_action") {
      throw new Error("unexpected kind");
    }
    expect(parsed.payload.action).toBe("request_revision");
    expect(parsed.payload.reportDate).toBe("2026-03-10");
    expect(parsed.payload.operator).toBe("ou_test");
    expect(parsed.payload.reason).toBe("补充来源");
  });

  it("应解析 mention 事件并输出 mention_event", () => {
    const parsed = __test__.parseCallbackBody(
      JSON.stringify({
        schema: "2.0",
        header: {
          event_type: "im.message.receive_v1",
          event_id: "evt_mention_001",
        },
        event: {
          operator: {
            open_id: "ou_test",
          },
          message: {
            message_type: "text",
            message_id: "om_001",
            chat_id: "oc_001",
            content: JSON.stringify({
              text: "@机器人 触发操作卡",
            }),
          },
        },
      }),
    );

    if ("challenge" in parsed) {
      throw new Error("unexpected challenge");
    }
    expect(parsed.kind).toBe("mention_event");
  });

  it("运维操作卡应包含主动触发按钮", () => {
    const card = __test__.buildOperationControlCard("2026-03-09");
    const actions = (card.elements[1] as { actions: Array<{ value: { operation: string } }> }).actions;
    expect(actions.map((item) => item.value.operation)).toEqual([
      "run_weekly",
      "recheck_weekly",
      "watchdog_weekly_dry_run",
      "notify_weekly_reminder",
      "query_weekly_status",
    ]);
  });

  it("应输出点击动作的状态回显推断", () => {
    const status = __test__.inferActionStatusEcho("approve_final");
    expect(status.reviewStatus).toBe("approved");
    expect(status.publishStatus).toBe("published");
    expect(status.shouldPublish).toBe(true);
  });
});
