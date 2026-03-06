import crypto from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";

import dayjs from "dayjs";
import { z } from "zod";

import type { ReviewInstruction, ReviewInstructionAction, ReviewInstructionStage, ReviewStatus } from "../core/types.js";
import type { ReviewInstructionStore } from "./instruction-store.js";

export interface FeishuConfig {
  webhookUrl?: string;
  webhookSecret?: string;
  callbackHost: string;
  callbackPort: number;
  callbackPath: string;
  callbackAuthToken?: string;
  callbackSigningSecret?: string;
}

export interface FeishuReviewNotification {
  reportDate: string;
  reviewStage: ReviewInstructionStage;
  reviewDeadlineAt: string | null;
  reviewMarkdownPath: string;
}

export interface FeishuPublishNotification {
  reportDate: string;
  reviewStatus: ReviewStatus;
  publishReason: string;
  publishMarkdownPath: string;
}

export interface ReviewActionPayload {
  mode: "weekly";
  reportDate: string;
  action: ReviewInstructionAction;
  stage?: ReviewInstructionStage;
  decidedAt?: string;
  operator?: string;
  reason?: string;
  traceId?: string;
  messageId?: string;
}

export interface StartFeishuCallbackServerInput {
  host: string;
  port: number;
  path: string;
  store: ReviewInstructionStore;
  authToken?: string;
  signingSecret?: string;
}

export function loadFeishuConfigFromEnv(): FeishuConfig {
  return {
    webhookUrl: process.env.FEISHU_WEBHOOK_URL,
    webhookSecret: process.env.FEISHU_WEBHOOK_SECRET,
    callbackHost: process.env.FEISHU_CALLBACK_HOST ?? "127.0.0.1",
    callbackPort: Number(process.env.FEISHU_CALLBACK_PORT ?? "8787"),
    callbackPath: process.env.FEISHU_CALLBACK_PATH ?? "/feishu/review-callback",
    callbackAuthToken: process.env.FEISHU_CALLBACK_AUTH_TOKEN,
    callbackSigningSecret: process.env.FEISHU_SIGNING_SECRET,
  };
}

export function isFeishuNotifyEnabled(config: FeishuConfig): boolean {
  return Boolean(config.webhookUrl);
}

export function buildReviewInstructionFromAction(payload: ReviewActionPayload): ReviewInstruction {
  const stage = payload.stage ?? resolveStageFromAction(payload.action);
  return {
    mode: "weekly",
    reportDate: payload.reportDate,
    stage,
    approved: isApprovedAction(payload.action),
    action: payload.action,
    source: "feishu_callback",
    decidedAt: payload.decidedAt ?? new Date().toISOString(),
    operator: payload.operator,
    reason: payload.reason,
    traceId: payload.traceId,
    messageId: payload.messageId,
  };
}

export class FeishuNotifier {
  constructor(private readonly config: Pick<FeishuConfig, "webhookUrl" | "webhookSecret">) {}

  async notifyReviewPending(input: FeishuReviewNotification): Promise<boolean> {
    if (!this.config.webhookUrl) {
      return false;
    }

    const deadline = input.reviewDeadlineAt ? dayjs(input.reviewDeadlineAt).format("YYYY-MM-DD HH:mm") : "未设置";
    const text = [
      "【AI 周报待审核】",
      `- reportDate: ${input.reportDate}`,
      `- stage: ${input.reviewStage}`,
      `- deadline: ${deadline} (Asia/Shanghai)`,
      `- reviewFile: ${input.reviewMarkdownPath}`,
    ].join("\n");
    await this.sendText(text);
    return true;
  }

  async notifyReviewReminder(input: FeishuReviewNotification): Promise<boolean> {
    if (!this.config.webhookUrl) {
      return false;
    }

    const deadline = input.reviewDeadlineAt ? dayjs(input.reviewDeadlineAt).format("YYYY-MM-DD HH:mm") : "未设置";
    const text = [
      "【AI 周报审核提醒】",
      `- reportDate: ${input.reportDate}`,
      `- stage: ${input.reviewStage}`,
      `- deadline: ${deadline} (Asia/Shanghai)`,
      `- reviewFile: ${input.reviewMarkdownPath}`,
    ].join("\n");
    await this.sendText(text);
    return true;
  }

  async notifyPublishResult(input: FeishuPublishNotification): Promise<boolean> {
    if (!this.config.webhookUrl) {
      return false;
    }

    const text = [
      "【AI 周报发布结果】",
      `- reportDate: ${input.reportDate}`,
      `- reviewStatus: ${input.reviewStatus}`,
      `- publishReason: ${input.publishReason}`,
      `- publishedFile: ${input.publishMarkdownPath}`,
    ].join("\n");
    await this.sendText(text);
    return true;
  }

  private async sendText(text: string): Promise<void> {
    const url = this.config.webhookUrl;
    if (!url) {
      return;
    }

    const body = buildWebhookBody(text, this.config.webhookSecret);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`feishu_webhook_failed:${response.status}`);
    }

    const payload = await response.json().catch(() => null);
    const code = typeof payload?.code === "number" ? payload.code : 0;
    if (code !== 0) {
      const message = typeof payload?.msg === "string" ? payload.msg : "unknown_error";
      throw new Error(`feishu_webhook_business_failed:${code}:${message}`);
    }
  }
}

export async function startFeishuReviewCallbackServer(input: StartFeishuCallbackServerInput): Promise<{
  close: () => Promise<void>;
  port: number;
}> {
  const server = createServer(async (req, res) => {
    try {
      const requestPath = getRequestPath(req.url ?? "");
      if (req.method === "GET" && requestPath === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method !== "POST" || requestPath !== input.path) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "not_found" }));
        return;
      }

      const rawBody = await readBody(req);
      const parsed = parseCallbackBody(rawBody);
      if ("challenge" in parsed) {
        // 兼容 Feishu URL 校验流程，直接原样返回 challenge。
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ challenge: parsed.challenge }));
        return;
      }

      verifyCallbackAuth({
        headers: req.headers,
        body: rawBody,
        requestUrl: req.url ?? "",
        authToken: input.authToken,
        signingSecret: input.signingSecret,
      });

      const instruction = buildReviewInstructionFromAction(parsed);
      await input.store.appendInstruction(instruction);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.startsWith("unauthorized:") ? 401 : 400;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port, input.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("feishu_callback_server_start_failed");
  }

  return {
    port: address.port,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

const challengeSchema = z.object({
  challenge: z.string().min(1),
});

const actionPayloadSchema = z.object({
  mode: z.literal("weekly").default("weekly"),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  action: z.enum(["approve_outline", "approve_final", "request_revision", "reject"]),
  stage: z.enum(["outline_review", "final_review"]).optional(),
  decidedAt: z.string().datetime().optional(),
  operator: z.string().min(1).optional(),
  reason: z.string().optional(),
  traceId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
});

function parseCallbackBody(rawBody: string): { challenge: string } | ReviewActionPayload {
  const value = JSON.parse(rawBody) as unknown;
  const challenge = extractChallenge(value);
  if (challenge) {
    return { challenge };
  }

  // 兼容当前简化 JSON 回调输入。
  const direct = actionPayloadSchema.safeParse(value);
  if (direct.success) {
    return direct.data;
  }

  // 适配飞书原生卡片回调结构，统一转换到内部动作模型。
  return actionPayloadSchema.parse(adaptFeishuCardActionPayload(value));
}

function verifyCallbackAuth(input: {
  headers: IncomingHttpHeaders;
  body: string;
  requestUrl: string;
  authToken?: string;
  signingSecret?: string;
}) {
  if (input.authToken) {
    const authorization = input.headers.authorization;
    const queryToken = tryGetQueryToken(input.requestUrl);
    const callbackToken = header(input.headers, "x-callback-token");
    const matched =
      authorization === `Bearer ${input.authToken}` || queryToken === input.authToken || callbackToken === input.authToken;
    if (!matched) {
      throw new Error("unauthorized:invalid_callback_token");
    }
  }

  if (!input.signingSecret) {
    return;
  }

  const timestamp = header(input.headers, "x-feishu-timestamp") ?? header(input.headers, "x-lark-request-timestamp");
  const signature = header(input.headers, "x-feishu-signature") ?? header(input.headers, "x-lark-signature");
  if (!timestamp || !signature) {
    throw new Error("unauthorized:missing_signature_headers");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const requestSeconds = Number(timestamp);
  if (!Number.isFinite(requestSeconds) || Math.abs(nowSeconds - requestSeconds) > 300) {
    throw new Error("unauthorized:expired_signature_timestamp");
  }

  const content = `${timestamp}.${input.body}`;
  const digest = crypto.createHmac("sha256", input.signingSecret).update(content).digest("hex");
  const digestBase64 = Buffer.from(digest, "hex").toString("base64");
  if (signature !== digest && signature !== digestBase64) {
    throw new Error("unauthorized:signature_mismatch");
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function header(headers: IncomingHttpHeaders, key: string): string | undefined {
  const value = headers[key];
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function resolveStageFromAction(action: ReviewInstructionAction): ReviewInstructionStage {
  if (action === "approve_outline") {
    return "outline_review";
  }
  return "final_review";
}

function isApprovedAction(action: ReviewInstructionAction): boolean {
  return action === "approve_outline" || action === "approve_final";
}

function buildWebhookBody(text: string, webhookSecret?: string) {
  if (!webhookSecret) {
    return {
      msg_type: "text",
      content: { text },
    };
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const stringToSign = `${timestamp}\n${webhookSecret}`;
  // 飞书机器人签名约定：HMAC key 使用 "timestamp + \\n + secret"，消息体为空串。
  const sign = crypto.createHmac("sha256", stringToSign).digest("base64");
  return {
    timestamp,
    sign,
    msg_type: "text",
    content: { text },
  };
}

function extractChallenge(input: unknown): string | undefined {
  const direct = challengeSchema.safeParse(input);
  if (direct.success) {
    return direct.data.challenge;
  }

  const record = asRecord(input);
  const eventRecord = record ? asRecord(record.event) : undefined;
  const maybe = eventRecord?.challenge;
  return typeof maybe === "string" && maybe.length > 0 ? maybe : undefined;
}

function adaptFeishuCardActionPayload(input: unknown) {
  const root = asRecord(input);
  if (!root) {
    throw new Error("invalid_callback_payload:expected_object");
  }

  const value = extractActionValueObject(root);
  if (!value) {
    throw new Error("invalid_callback_payload:missing_action_value");
  }

  const action =
    getString(value, "action") ??
    getString(value, "review_action") ??
    getString(value, "reviewAction") ??
    getString(value, "action_type");
  const reportDate = getString(value, "reportDate") ?? getString(value, "report_date");
  const stage = getString(value, "stage");

  const eventRecord = asRecord(root.event);
  const operator = resolveOperator(root, eventRecord) ?? getString(value, "operator");
  const reason = getString(value, "reason") ?? getString(value, "comment");
  const messageId =
    getString(value, "messageId") ??
    getString(value, "message_id") ??
    getString(root, "open_message_id") ??
    getString(eventRecord, "open_message_id");
  const traceId =
    getString(value, "traceId") ??
    getString(value, "trace_id") ??
    getString(asRecord(root.header), "event_id") ??
    getString(root, "event_id");
  const decidedAt =
    getString(value, "decidedAt") ??
    normalizeCreateTime(getString(eventRecord, "create_time") ?? getString(root, "create_time"));

  return {
    mode: "weekly",
    reportDate,
    action,
    ...(stage ? { stage } : {}),
    ...(decidedAt ? { decidedAt } : {}),
    ...(operator ? { operator } : {}),
    ...(reason ? { reason } : {}),
    ...(traceId ? { traceId } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

function extractActionValueObject(root: Record<string, unknown>): Record<string, unknown> | null {
  const candidates: unknown[] = [
    asRecord(root.action)?.value,
    asRecord(root.action)?.form_value,
    asRecord(root.event)?.action ? asRecord(asRecord(root.event)?.action)?.value : undefined,
    asRecord(root.event)?.action ? asRecord(asRecord(root.event)?.action)?.form_value : undefined,
    asRecord(asRecord(root.event)?.context)?.action ? asRecord(asRecord(asRecord(root.event)?.context)?.action)?.value : undefined,
    asRecord(root.data)?.value,
  ];

  for (const candidate of candidates) {
    const objectValue = parsePossibleObject(candidate);
    if (objectValue) {
      return objectValue;
    }
  }

  return null;
}

function parsePossibleObject(input: unknown): Record<string, unknown> | null {
  if (isRecord(input)) {
    return input;
  }

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function resolveOperator(root: Record<string, unknown>, eventRecord?: Record<string, unknown>) {
  const candidates = [
    asRecord(root.operator),
    asRecord(eventRecord?.operator),
    asRecord(eventRecord?.operator_id),
    asRecord(eventRecord?.user),
  ].filter((item): item is Record<string, unknown> => Boolean(item));

  for (const candidate of candidates) {
    const value =
      getString(candidate, "name") ??
      getString(candidate, "open_id") ??
      getString(candidate, "union_id") ??
      getString(candidate, "user_id");
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeCreateTime(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }

  if (/^\d+$/.test(input)) {
    const numberValue = Number(input);
    if (!Number.isFinite(numberValue)) {
      return undefined;
    }
    const milliseconds = input.length >= 13 ? numberValue : numberValue * 1000;
    return new Date(milliseconds).toISOString();
  }
  return undefined;
}

function getString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!record) {
    return undefined;
  }
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return isRecord(input) ? input : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function tryGetQueryToken(requestUrl: string): string | undefined {
  if (!requestUrl.includes("?")) {
    return undefined;
  }
  try {
    const parsed = new URL(`http://localhost${requestUrl}`);
    const token = parsed.searchParams.get("token");
    return token ?? undefined;
  } catch {
    return undefined;
  }
}

function getRequestPath(requestUrl: string): string {
  try {
    return new URL(`http://localhost${requestUrl}`).pathname;
  } catch {
    return requestUrl;
  }
}

export const __test__ = {
  buildWebhookBody,
  parseCallbackBody,
  adaptFeishuCardActionPayload,
  verifyCallbackAuth,
};
