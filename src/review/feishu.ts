import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import path from "node:path";

import dayjs from "dayjs";
import { z } from "zod";

import type {
  ReviewFeedbackPayload,
  ReviewInstruction,
  ReviewInstructionAction,
  ReviewInstructionStage,
  ReviewStatus,
} from "../core/types.js";
import type { OperationJobType } from "../daemon/types.js";
import type { ReviewInstructionStore } from "./instruction-store.js";
import { normalizeFeedbackPayload, reviewFeedbackPayloadSchema } from "./feedback-schema.js";

export interface FeishuConfig {
  appId?: string;
  appSecret?: string;
  reviewChatId?: string;
  reportPublicBaseUrl?: string;
  notificationRoot?: string;
  debugVerbose?: boolean;
  callbackHost: string;
  callbackPort: number;
  callbackPath: string;
  callbackAuthToken?: string;
  callbackSigningSecret?: string;
}

export interface FeishuReviewNotification {
  runId: string;
  reportDate: string;
  reviewStage: ReviewInstructionStage;
  reviewDeadlineAt: string | null;
  reviewMarkdownPath: string;
}

export interface FeishuPublishNotification {
  runId: string;
  reportDate: string;
  reviewStatus: ReviewStatus;
  publishReason: string;
  publishMarkdownPath: string;
}

export interface FeishuLlmFallbackNotification {
  runId: string;
  reportDate: string;
  mode: "daily" | "weekly";
  reason: string;
}

interface FeishuMainCardRecord {
  mode: "weekly";
  reportDate: string;
  runId: string;
  messageId: string;
  stage: "outline_review" | "final_review" | "published" | "rejected";
  updatedAt: string;
}

export interface FeishuActionStatusEcho {
  reviewStage: string;
  reviewStatus: string;
  publishStatus: string;
  shouldPublish: boolean;
  note?: string;
}

export interface FeishuActionResultNotification {
  reportDate: string;
  action: ReviewInstructionAction;
  operator?: string;
  result: "accepted" | "failed";
  statusEcho?: FeishuActionStatusEcho;
  errorMessage?: string;
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
  feedback?: ReviewFeedbackPayload;
}

export interface FeishuOperationActionPayload {
  mode: "weekly";
  operation: OperationJobType;
  reportDate?: string;
  generatedAt?: string;
  dryRun?: boolean;
  operator?: string;
  reason?: string;
  traceId?: string;
  messageId?: string;
}

export interface FeishuMentionEventPayload {
  chatId?: string;
  text: string;
  operator?: string;
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
  notifier?: Pick<FeishuNotifier, "notifyActionResult">;
  auditLogger?: (event: FeishuCallbackAuditEvent) => Promise<void>;
  statusEchoProvider?: (input: {
    reportDate: string;
    action: ReviewInstructionAction;
    stage: ReviewInstructionStage;
  }) => Promise<FeishuActionStatusEcho | null>;
  operationHandler?: (input: FeishuOperationActionPayload) => Promise<{
    accepted: boolean;
    message: string;
    duplicated?: boolean;
    jobId?: number;
  }>;
  mentionHandler?: (input: FeishuMentionEventPayload) => Promise<{
    handled: boolean;
    message: string;
  }>;
  onReviewAccepted?: (input: { instruction: ReviewInstruction; payload: ReviewActionPayload }) => Promise<void>;
}

export interface FeishuCallbackAuditEvent {
  reportDate: string;
  action: ReviewInstructionAction;
  stage: ReviewInstructionStage;
  operator?: string;
  traceId?: string;
  messageId?: string;
  result: "accepted" | "failed";
  notifyResult: "sent" | "failed" | "skipped";
  errorMessage?: string;
  createdAt: string;
}

// tenant token 在单进程内短期缓存，减少每条通知都请求鉴权接口的开销与限流风险。
const tenantTokenCache = new Map<string, { token: string; expireAtMs: number }>();
const REVIEW_ACTION_SEMANTIC_DEDUP_SECONDS = 120;
const CALLBACK_EVENT_DEDUP_SECONDS = 120;
const ACTION_RECEIPT_DEDUP_SECONDS = 120;
const MAIN_CARD_SAME_STAGE_NOOP_SECONDS = 45;

export function loadFeishuConfigFromEnv(): FeishuConfig {
  return {
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    reviewChatId: process.env.REVIEW_CHAT_ID,
    reportPublicBaseUrl: process.env.REPORT_PUBLIC_BASE_URL,
    notificationRoot: process.env.FEISHU_NOTIFICATION_ROOT ?? "outputs/notifications/feishu",
    debugVerbose: process.env.FEISHU_DEBUG_VERBOSE === "true",
    callbackHost: process.env.FEISHU_CALLBACK_HOST ?? "127.0.0.1",
    callbackPort: Number(process.env.FEISHU_CALLBACK_PORT ?? "8787"),
    callbackPath: process.env.FEISHU_CALLBACK_PATH ?? "/feishu/review-callback",
    callbackAuthToken: process.env.FEISHU_CALLBACK_AUTH_TOKEN,
    callbackSigningSecret: process.env.FEISHU_SIGNING_SECRET,
  };
}

export function isFeishuNotifyEnabled(config: FeishuConfig): boolean {
  return hasAppConfig(config);
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
    feedback: payload.feedback,
  };
}

export class FeishuNotifier {
  constructor(
    private readonly config: {
      appId?: string;
      appSecret?: string;
      reviewChatId?: string;
      reportPublicBaseUrl?: string;
      notificationRoot?: string;
      debugVerbose?: boolean;
    },
  ) {}

  isEnabled(): boolean {
    return hasAppConfig(this.config);
  }

  async notifyReviewPending(input: FeishuReviewNotification): Promise<boolean> {
    const reviewUrl = this.buildPublicUrl(input.reviewMarkdownPath);
    const stageLabel = input.reviewStage === "outline_review" ? "待大纲审核" : "待终稿审核";
    const deadlineLabel = input.reviewDeadlineAt
      ? dayjs(input.reviewDeadlineAt).format("YYYY-MM-DD HH:mm")
      : "未设置";
    const guide = input.reviewStage === "outline_review" ? "请先快速浏览重点摘要，再点击“大纲通过”。" : "请确认内容可发布后，点击“终稿通过并发布”。";

    const card = buildReviewMainCard({
      reportDate: input.reportDate,
      stage: input.reviewStage,
      stageLabel,
      guide,
      deadlineLabel,
      reviewUrl,
      publishedUrl: null,
      showDebug: this.config.debugVerbose === true,
      debugFields: {
        runId: input.runId,
        reviewFile: input.reviewMarkdownPath,
      },
    });

    const upserted = await this.upsertMainReviewCard({
      reportDate: input.reportDate,
      runId: input.runId,
      stage: input.reviewStage,
      card,
    });

    // 主卡 upsert 成功后不再额外发技术文本，降低群内噪音。
    return upserted;
  }

  async notifyReviewReminder(input: FeishuReviewNotification): Promise<boolean> {
    const deadline = input.reviewDeadlineAt ? dayjs(input.reviewDeadlineAt).format("YYYY-MM-DD HH:mm") : "未设置";
    const reviewUrl = this.buildPublicUrl(input.reviewMarkdownPath);
    const text = [
      "【AI 周报审核提醒】",
      `本期周报（${input.reportDate}）仍待审核，截止时间 ${deadline}（Asia/Shanghai）。`,
      input.reviewStage === "outline_review" ? "下一步：请先完成大纲审核。" : "下一步：请完成终稿审核。",
      ...(reviewUrl ? [`查看待审核稿：${reviewUrl}`] : []),
    ].join("\n");
    return this.sendText(text);
  }

  async notifyPublishResult(input: FeishuPublishNotification): Promise<boolean> {
    const publishUrl = this.buildPublicUrl(input.publishMarkdownPath);
    const stage = input.reviewStatus === "rejected" ? "rejected" : "published";
    const stageLabel = input.reviewStatus === "rejected" ? "本轮已拒绝发布" : "本轮已发布";
    const card = buildReviewMainCard({
      reportDate: input.reportDate,
      stage,
      stageLabel,
      guide: input.reviewStatus === "rejected" ? "当前 run 已终止。若需继续，请新建一次 run。" : "发布已完成，本轮无需再执行审核动作。",
      deadlineLabel: "已结束",
      reviewUrl: null,
      publishedUrl: publishUrl,
      showDebug: this.config.debugVerbose === true,
      debugFields: {
        runId: input.runId,
        publishReason: input.publishReason,
        publishedFile: input.publishMarkdownPath,
      },
    });

    await this.upsertMainReviewCard({
      reportDate: input.reportDate,
      runId: input.runId,
      stage,
      card,
    });

    const text = [
      "【AI 周报发布结果】",
      input.reviewStatus === "rejected"
        ? `本期周报（${input.reportDate}）已拒绝发布。`
        : `本期周报（${input.reportDate}）已发布完成。`,
      ...(publishUrl ? [`查看已发布稿：${publishUrl}`] : []),
    ].join("\n");
    return this.sendText(text);
  }

  async notifyActionResult(input: FeishuActionResultNotification): Promise<boolean> {
    const operator = input.operator ?? "某位审核人";
    const actionLabel = toActionLabel(input.action);
    if (input.result === "failed") {
      const text = [
        "【AI 周报审核动作回执】",
        `${operator} 的操作未生效：${actionLabel}。`,
        ...(input.errorMessage ? [`原因：${input.errorMessage}`] : []),
      ].join("\n");
      return this.sendText(text);
    }

    const stageText = resolveStatusEchoText(input.statusEcho);
    const debug = this.config.debugVerbose
      ? `\n[debug] action=${input.action}, reportDate=${input.reportDate}, reviewStage=${input.statusEcho?.reviewStage ?? "unknown"}`
      : "";
    const text = `【AI 周报审核动作回执】\n${operator} 已执行：${actionLabel}。\n${stageText}${debug}`;
    return this.sendText(text);
  }

  async notifyOperationControlCard(input: { chatId?: string; reportDate: string }): Promise<boolean> {
    if (!hasAppConfig(this.config)) {
      return false;
    }

    const card = buildOperationControlCard(input.reportDate);
    const messageId = await this.sendInteractiveCard(card, input.chatId);
    return Boolean(messageId);
  }

  async notifyOperationResult(input: {
    operator?: string;
    operation: OperationJobType;
    result: "success" | "failed";
    detail: string;
  }): Promise<boolean> {
    const operator = input.operator ?? "某位同学";
    const statusText = input.result === "success" ? "执行成功" : "执行失败";
    const text = [
      "【AI 周报主动触发回执】",
      `${operator} 触发了：${toOperationLabel(input.operation)}`,
      `结果：${statusText}`,
      `详情：${input.detail}`,
    ].join("\n");
    return this.sendText(text);
  }

  async notifyLlmFallback(input: FeishuLlmFallbackNotification): Promise<boolean> {
    const text = [
      "【AI 报告 LLM 降级告警】",
      `mode=${input.mode}, reportDate=${input.reportDate}`,
      "本次已自动回退到规则摘要，不影响审核与发布主流程。",
      `原因：${input.reason}`,
      `runId：${input.runId}`,
    ].join("\n");
    return this.sendText(text);
  }

  private async sendText(text: string): Promise<boolean> {
    return this.sendTextByApp(text);
  }

  private async sendTextByApp(text: string): Promise<boolean> {
    if (!hasAppConfig(this.config)) {
      return false;
    }

    const token = await fetchTenantAccessToken(this.config.appId!, this.config.appSecret!);
    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        receive_id: this.config.reviewChatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    });

    if (!response.ok) {
      throw new Error(`feishu_app_send_failed:${response.status}`);
    }

    const payload = await response.json().catch(() => null);
    const code = typeof payload?.code === "number" ? payload.code : 0;
    if (code !== 0) {
      const message = typeof payload?.msg === "string" ? payload.msg : "unknown_error";
      throw new Error(`feishu_app_business_failed:${code}:${message}`);
    }

    return true;
  }

  private buildPublicUrl(filePath: string): string | null {
    const base = this.config.reportPublicBaseUrl?.trim();
    if (!base) {
      return null;
    }
    const normalizedPath = filePath.split(path.sep).join("/").replace(/^\.?\//, "");
    try {
      const baseUrl = new URL(base);
      const baseSegments = baseUrl.pathname.split("/").filter(Boolean);
      const fileSegments = normalizedPath.split("/").filter(Boolean);
      const overlap = findPathOverlap(baseSegments, fileSegments);
      const merged = [...baseSegments, ...fileSegments.slice(overlap)];
      baseUrl.pathname = `/${merged.join("/")}`;
      return baseUrl.toString().replace(/\/+$/, "");
    } catch {
      // 兼容非标准 URL 输入（例如内网网关短链接），至少保证路径拼接行为可预期。
      const normalizedBase = base.replace(/\/+$/, "");
      return `${normalizedBase}/${normalizedPath}`;
    }
  }

  private async upsertMainReviewCard(input: {
    reportDate: string;
    runId: string;
    stage: FeishuMainCardRecord["stage"];
    card: Record<string, unknown>;
  }): Promise<boolean> {
    const record = await this.readMainCardRecord(input.reportDate);
    if (record && record.runId === input.runId) {
      if (record.stage === input.stage && isRecentTimestamp(record.updatedAt, MAIN_CARD_SAME_STAGE_NOOP_SECONDS)) {
        // 同 runId + 同 stage 的高频重复通知不必再次 patch，避免群里出现重复卡片更新噪音。
        return true;
      }
      try {
        await this.updateInteractiveCard(record.messageId, input.card);
        await this.writeMainCardRecord({
          ...record,
          stage: input.stage,
          updatedAt: new Date().toISOString(),
        });
        return true;
      } catch {
        // messageId 可能已失效，降级发新卡并覆盖记录。
      }
    }

    const messageId = await this.sendInteractiveCard(input.card);
    if (!messageId) {
      return false;
    }
    await this.writeMainCardRecord({
      mode: "weekly",
      reportDate: input.reportDate,
      runId: input.runId,
      messageId,
      stage: input.stage,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  private async sendInteractiveCard(card: Record<string, unknown>, chatId?: string): Promise<string | null> {
    if (!hasAppConfig(this.config)) {
      return null;
    }

    const token = await fetchTenantAccessToken(this.config.appId!, this.config.appSecret!);
    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        receive_id: chatId ?? this.config.reviewChatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    });
    if (!response.ok) {
      throw new Error(`feishu_app_card_send_failed:${response.status}`);
    }
    const payload = (await response.json().catch(() => null)) as
      | { code?: number; msg?: string; data?: { message_id?: string } }
      | null;
    const code = typeof payload?.code === "number" ? payload.code : 0;
    if (code !== 0) {
      throw new Error(`feishu_app_card_business_failed:${code}:${payload?.msg ?? "unknown_error"}`);
    }
    return payload?.data?.message_id ?? null;
  }

  private async updateInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    if (!hasAppConfig(this.config)) {
      return;
    }
    const token = await fetchTenantAccessToken(this.config.appId!, this.config.appSecret!);
    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    });
    if (!response.ok) {
      throw new Error(`feishu_app_card_update_failed:${response.status}`);
    }
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string } | null;
    const code = typeof payload?.code === "number" ? payload.code : 0;
    if (code !== 0) {
      throw new Error(`feishu_app_card_update_business_failed:${code}:${payload?.msg ?? "unknown_error"}`);
    }
  }

  private getMainCardRecordPath(reportDate: string) {
    const root = this.config.notificationRoot ?? "outputs/notifications/feishu";
    return path.join(root, "main-cards", "weekly", `${reportDate}.json`);
  }

  private async readMainCardRecord(reportDate: string): Promise<FeishuMainCardRecord | null> {
    const filePath = this.getMainCardRecordPath(reportDate);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content) as FeishuMainCardRecord;
      if (parsed.reportDate !== reportDate) {
        return null;
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async writeMainCardRecord(record: FeishuMainCardRecord) {
    const filePath = this.getMainCardRecordPath(record.reportDate);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf-8");
  }
}

export async function startFeishuReviewCallbackServer(input: StartFeishuCallbackServerInput): Promise<{
  close: () => Promise<void>;
  port: number;
}> {
  // 回调链路在弱网下可能出现重复投递，这里使用进程内短窗口去重，优先拦截“重复发卡/重复入队/重复回执”噪音。
  const mentionEventDedupeCache = new Map<string, number>();
  const operationEventDedupeCache = new Map<string, number>();
  const actionReceiptDedupeCache = new Map<string, number>();

  const server = createServer(async (req, res) => {
    let parsedReviewAction: ReviewActionPayload | null = null;
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
      if (parsed.kind === "review_action") {
        parsedReviewAction = parsed.payload;
      }

      verifyCallbackAuth({
        headers: req.headers,
        body: rawBody,
        requestUrl: req.url ?? "",
        authToken: input.authToken,
        signingSecret: input.signingSecret,
      });

      if (parsed.kind === "mention_event") {
        const mentionDedupeKey = buildCallbackEventDedupeKey("mention", {
          traceId: parsed.payload.traceId,
          messageId: parsed.payload.messageId,
          reportDate: parsed.payload.chatId,
          actionOrOperation: parsed.payload.text,
        });
        if (isRecentDuplicateEvent(mentionEventDedupeCache, mentionDedupeKey, CALLBACK_EVENT_DEDUP_SECONDS)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              handled: true,
              duplicated: true,
              ...buildCallbackToastPayload({
                success: true,
                content: "已处理过相同请求，忽略重复提交。",
              }),
            }),
          );
          return;
        }

        if (!input.mentionHandler) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              handled: false,
              ...buildCallbackToastPayload({
                success: true,
                content: "已收到消息，当前未启用主动触发能力。",
              }),
            }),
          );
          return;
        }

        const mentionResult = await input.mentionHandler(parsed.payload);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            handled: mentionResult.handled,
            ...buildCallbackToastPayload({
              success: mentionResult.handled,
              content: mentionResult.message,
            }),
          }),
        );
        return;
      }

      if (parsed.kind === "operation_action") {
        const operationDedupeKey = buildCallbackEventDedupeKey("operation", {
          traceId: parsed.payload.traceId,
          messageId: parsed.payload.messageId,
          reportDate: parsed.payload.reportDate,
          actionOrOperation: parsed.payload.operation,
        });
        if (isRecentDuplicateEvent(operationEventDedupeCache, operationDedupeKey, CALLBACK_EVENT_DEDUP_SECONDS)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              duplicated: true,
              ...buildCallbackToastPayload({
                success: true,
                content: "该任务已在受理中，忽略重复提交。",
              }),
            }),
          );
          return;
        }

        if (!input.operationHandler) {
          throw new Error("operation_handler_not_configured");
        }

        const operationResult = await input.operationHandler(parsed.payload);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: operationResult.accepted,
            ...(operationResult.duplicated ? { duplicated: true } : {}),
            ...(operationResult.jobId ? { jobId: operationResult.jobId } : {}),
            ...buildCallbackToastPayload({
              success: operationResult.accepted,
              content: operationResult.message,
            }),
          }),
        );
        return;
      }

      const reviewPayload = parsed.payload;
      const instruction = buildReviewInstructionFromAction(reviewPayload);

      // 飞书可能因网络抖动重试同一次点击事件，这里在写入前做幂等判重，避免重复回执刷屏。
      const duplicated = await input.store.findDuplicateInstruction({
        mode: instruction.mode,
        reportDate: instruction.reportDate,
        stage: instruction.stage,
        action: instruction.action,
        traceId: instruction.traceId,
        messageId: instruction.messageId,
      });
      if (duplicated) {
        await appendCallbackAuditLog(input.auditLogger, {
          reportDate: reviewPayload.reportDate,
          action: reviewPayload.action,
          stage: instruction.stage,
          operator: instruction.operator,
          traceId: instruction.traceId,
          messageId: instruction.messageId,
          result: "accepted",
          notifyResult: "skipped",
          errorMessage: "duplicate_callback_ignored",
          createdAt: new Date().toISOString(),
        });

        console.log(
          `[feishu-callback] duplicated reportDate=${reviewPayload.reportDate}, action=${reviewPayload.action}, stage=${instruction.stage}, traceId=${
            instruction.traceId ?? "none"
          }`,
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            duplicated: true,
            ...buildCallbackToastPayload({
              success: true,
              content: `该动作已处理，已忽略重复提交（${toActionLabel(reviewPayload.action)}）`,
            }),
          }),
        );
        return;
      }

      const latestInstruction = await input.store.getLatestInstruction({
        mode: instruction.mode,
        reportDate: instruction.reportDate,
        stage: instruction.stage,
      });
      if (
        isSemanticallyDuplicatedReviewAction({
          latest: latestInstruction,
          current: instruction,
          duplicateWindowSeconds: REVIEW_ACTION_SEMANTIC_DEDUP_SECONDS,
        })
      ) {
        await appendCallbackAuditLog(input.auditLogger, {
          reportDate: reviewPayload.reportDate,
          action: reviewPayload.action,
          stage: instruction.stage,
          operator: instruction.operator,
          traceId: instruction.traceId,
          messageId: instruction.messageId,
          result: "accepted",
          notifyResult: "skipped",
          errorMessage: "duplicate_callback_semantic_ignored",
          createdAt: new Date().toISOString(),
        });

        console.log(
          `[feishu-callback] duplicated-semantic reportDate=${reviewPayload.reportDate}, action=${reviewPayload.action}, stage=${instruction.stage}`,
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            duplicated: true,
            ...buildCallbackToastPayload({
              success: true,
              content: `该动作刚刚已处理，已忽略重复提交（${toActionLabel(reviewPayload.action)}），请以最新状态卡为准。`,
            }),
          }),
        );
        return;
      }

      await input.store.appendInstruction(instruction);

      // 回调里优先回显“当前状态”，若状态查询失败则回退到动作级推断，保证点击方总能得到可理解反馈。
      const statusEcho =
        (await input.statusEchoProvider?.({
          reportDate: reviewPayload.reportDate,
          action: reviewPayload.action,
          stage: instruction.stage,
        })) ?? inferActionStatusEcho(reviewPayload.action);

      let notifyWarning: string | undefined;
      let notifySent = false;
      try {
        if (input.notifier) {
          const receiptDedupeKey = `${reviewPayload.reportDate}|${instruction.stage}|${reviewPayload.action}|accepted`;
          const duplicatedReceipt = isRecentDuplicateEvent(
            actionReceiptDedupeCache,
            receiptDedupeKey,
            ACTION_RECEIPT_DEDUP_SECONDS,
          );
          if (!duplicatedReceipt) {
            notifySent = await input.notifier.notifyActionResult({
              reportDate: reviewPayload.reportDate,
              action: reviewPayload.action,
              operator: instruction.operator,
              result: "accepted",
              statusEcho,
            });
          }
        }
      } catch (error) {
        // 动作写入已成功，通知失败不应反向污染审核主流程。
        notifyWarning = error instanceof Error ? error.message : String(error);
      }
      await appendCallbackAuditLog(input.auditLogger, {
        reportDate: reviewPayload.reportDate,
        action: reviewPayload.action,
        stage: instruction.stage,
        operator: instruction.operator,
        traceId: instruction.traceId,
        messageId: instruction.messageId,
        result: "accepted",
        notifyResult: !input.notifier ? "skipped" : notifyWarning ? "failed" : notifySent ? "sent" : "skipped",
        errorMessage: notifyWarning,
        createdAt: new Date().toISOString(),
      });

      let acceptWarning: string | undefined;
      try {
        await input.onReviewAccepted?.({ instruction, payload: reviewPayload });
      } catch (error) {
        // 自动推进链路失败不影响“动作已写入”事实，仅以 warning 回传便于排障。
        acceptWarning = error instanceof Error ? error.message : String(error);
      }

      console.log(
        `[feishu-callback] accepted reportDate=${reviewPayload.reportDate}, action=${reviewPayload.action}, stage=${instruction.stage}, operator=${instruction.operator ?? "unknown"}`,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          ...(notifyWarning || acceptWarning
            ? {
                warning: [
                  notifyWarning ? `notify_failed:${notifyWarning}` : null,
                  acceptWarning ? `post_accept_failed:${acceptWarning}` : null,
                ]
                  .filter(Boolean)
                  .join(";"),
              }
            : {}),
          ...buildCallbackToastPayload({
            success: true,
            content: notifyWarning ? `已接收：${toActionLabel(reviewPayload.action)}（通知发送失败）` : `已接收：${toActionLabel(reviewPayload.action)}`,
          }),
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (parsedReviewAction) {
        let notifyWarning: string | undefined;
        let notifySent = false;
        // 失败路径也尝试发送群内回执，避免“点击后静默失败”。
        if (input.notifier) {
          await input.notifier
            .notifyActionResult({
              reportDate: parsedReviewAction.reportDate,
              action: parsedReviewAction.action,
              operator: parsedReviewAction.operator,
              result: "failed",
              statusEcho: inferActionStatusEcho(parsedReviewAction.action),
              errorMessage: message,
            })
            .then((sent) => {
              notifySent = sent;
            })
            .catch((notifyError) => {
              notifyWarning = notifyError instanceof Error ? notifyError.message : String(notifyError);
            });
        }

        await appendCallbackAuditLog(input.auditLogger, {
          reportDate: parsedReviewAction.reportDate,
          action: parsedReviewAction.action,
          stage: parsedReviewAction.stage ?? resolveStageFromAction(parsedReviewAction.action),
          operator: parsedReviewAction.operator,
          traceId: parsedReviewAction.traceId,
          messageId: parsedReviewAction.messageId,
          result: "failed",
          notifyResult: !input.notifier ? "skipped" : notifyWarning ? "failed" : notifySent ? "sent" : "skipped",
          errorMessage: notifyWarning ? `${message}; notify:${notifyWarning}` : message,
          createdAt: new Date().toISOString(),
        });
      }

      const status = message.startsWith("unauthorized:") ? 401 : 400;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: message,
          ...buildCallbackToastPayload({
            success: false,
            content: `操作失败：${shortErrorMessage(message)}`,
          }),
        }),
      );
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
  feedback: reviewFeedbackPayloadSchema.optional(),
});

const operationTypeSchema = z.enum([
  "run_daily",
  "run_weekly",
  "recheck_weekly",
  "watchdog_weekly",
  "watchdog_weekly_dry_run",
  "notify_weekly_reminder",
  "query_weekly_status",
  "git_sync",
]);

const operationPayloadSchema = z.object({
  mode: z.literal("weekly").default("weekly"),
  operation: operationTypeSchema,
  reportDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  generatedAt: z.string().datetime().optional(),
  dryRun: z.boolean().optional(),
  operator: z.string().min(1).optional(),
  reason: z.string().optional(),
  traceId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
});

type ParsedCallbackBody =
  | { challenge: string }
  | { kind: "review_action"; payload: ReviewActionPayload }
  | { kind: "operation_action"; payload: FeishuOperationActionPayload }
  | { kind: "mention_event"; payload: FeishuMentionEventPayload };

function parseCallbackBody(rawBody: string): ParsedCallbackBody {
  const value = JSON.parse(rawBody) as unknown;
  const challenge = extractChallenge(value);
  if (challenge) {
    return { challenge };
  }

  const mention = extractMentionEvent(value);
  if (mention) {
    return {
      kind: "mention_event",
      payload: mention,
    };
  }

  // 兼容当前简化 JSON 回调输入。
  const direct = actionPayloadSchema.safeParse(value);
  if (direct.success) {
    const feedback = normalizeFeedbackPayload(value);
    if (feedback) {
      return {
        kind: "review_action",
        payload: { ...direct.data, feedback },
      };
    }
    return {
      kind: "review_action",
      payload: direct.data,
    };
  }

  const directOperation = operationPayloadSchema.safeParse(value);
  if (directOperation.success) {
    return {
      kind: "operation_action",
      payload: directOperation.data,
    };
  }

  // 适配飞书原生卡片回调结构，统一转换到内部动作模型。
  const adapted = adaptFeishuCardActionPayload(value);
  if ("operation" in adapted) {
    return {
      kind: "operation_action",
      payload: operationPayloadSchema.parse(adapted),
    };
  }

  const reviewPayload = actionPayloadSchema.parse(adapted);
  return {
    kind: "review_action",
    payload: reviewPayload,
  };
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

  const operation =
    getString(value, "operation") ??
    getString(value, "op_action") ??
    getString(value, "operation_action") ??
    getString(value, "operationAction");

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

  if (operation) {
    return {
      mode: "weekly",
      operation,
      ...(reportDate ? { reportDate } : {}),
      ...(decidedAt ? { generatedAt: decidedAt } : {}),
      ...(operator ? { operator } : {}),
      ...(reason ? { reason } : {}),
      ...(traceId ? { traceId } : {}),
      ...(messageId ? { messageId } : {}),
      ...(typeof value.dryRun === "boolean" ? { dryRun: value.dryRun } : {}),
    };
  }

  const action =
    getString(value, "action") ??
    getString(value, "review_action") ??
    getString(value, "reviewAction") ??
    getString(value, "action_type");
  const feedback = normalizeFeedbackPayload(value.feedback ?? value.revision ?? value);

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
    ...(feedback ? { feedback } : {}),
  };
}

function extractMentionEvent(input: unknown): FeishuMentionEventPayload | null {
  const root = asRecord(input);
  if (!root) {
    return null;
  }

  const eventType =
    getString(asRecord(root.header), "event_type") ??
    getString(root, "event_type") ??
    getString(asRecord(root.event), "type");
  if (eventType !== "im.message.receive_v1") {
    return null;
  }

  const event = asRecord(root.event);
  const message = asRecord(event?.message);
  if (!message) {
    return null;
  }
  const messageType = getString(message, "message_type");
  if (messageType !== "text") {
    return null;
  }

  const content = parsePossibleObject(message.content);
  const text = getString(content ?? undefined, "text");
  if (!text) {
    return null;
  }

  // 只在明显的主动触发关键词出现时当作“运维操作卡请求”，避免污染普通群消息。
  if (!/(运维|操作卡|ops|触发|recheck|watchdog)/i.test(text)) {
    return null;
  }

  const operator = resolveOperator(root, event);
  const messageId = getString(message, "message_id") ?? getString(root, "open_message_id");
  const traceId = getString(asRecord(root.header), "event_id") ?? getString(root, "event_id");
  const chatId = getString(message, "chat_id");

  return {
    chatId,
    text,
    operator,
    traceId: traceId ?? undefined,
    messageId: messageId ?? undefined,
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

async function fetchTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const cacheKey = `${appId}:${appSecret}`;
  const cached = tenantTokenCache.get(cacheKey);
  const now = Date.now();
  // 提前 60s 失效，避免 token 在请求飞书消息接口时刚好过期。
  if (cached && cached.expireAtMs > now + 60_000) {
    return cached.token;
  }

  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`feishu_token_http_failed:${response.status}`);
  }

  const payload = (await response.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
  const code = typeof payload.code === "number" ? payload.code : 0;
  if (code !== 0 || !payload.tenant_access_token) {
    throw new Error(`feishu_token_business_failed:${code}:${payload.msg ?? "unknown_error"}`);
  }

  const expireSeconds = typeof payload.expire === "number" ? payload.expire : 3600;
  tenantTokenCache.set(cacheKey, {
    token: payload.tenant_access_token,
    expireAtMs: now + expireSeconds * 1000,
  });

  return payload.tenant_access_token;
}

function hasAppConfig(input: Pick<FeishuConfig, "appId" | "appSecret" | "reviewChatId">): boolean {
  return Boolean(input.appId && input.appSecret && input.reviewChatId);
}

function inferActionStatusEcho(action: ReviewInstructionAction): FeishuActionStatusEcho {
  if (action === "approve_outline") {
    return {
      reviewStage: "final_review",
      reviewStatus: "pending_review",
      publishStatus: "pending",
      shouldPublish: false,
      note: "大纲动作已记录，等待 recheck 进入终稿审核",
    };
  }

  if (action === "approve_final") {
    return {
      reviewStage: "none",
      reviewStatus: "approved",
      publishStatus: "published",
      shouldPublish: true,
      note: "终稿动作已记录，执行 recheck 后将发布",
    };
  }

  if (action === "request_revision") {
    return {
      reviewStage: "final_review",
      reviewStatus: "pending_review",
      publishStatus: "pending",
      shouldPublish: false,
      note: "修订动作已记录，执行 recheck 后应用修订",
    };
  }

  return {
    reviewStage: "none",
    reviewStatus: "rejected",
    publishStatus: "pending",
    shouldPublish: false,
    note: "reject 动作已记录，当前 run 不再发布",
  };
}

function toActionLabel(action: ReviewInstructionAction) {
  if (action === "approve_outline") {
    return "大纲通过";
  }
  if (action === "approve_final") {
    return "终稿通过并发布";
  }
  if (action === "request_revision") {
    return "要求修订";
  }
  return "拒绝本次发布";
}

function toOperationLabel(operation: OperationJobType) {
  if (operation === "run_daily") return "生成日报";
  if (operation === "run_weekly") return "生成周报";
  if (operation === "recheck_weekly") return "执行 recheck";
  if (operation === "watchdog_weekly") return "执行 watchdog";
  if (operation === "watchdog_weekly_dry_run") return "执行 watchdog dry-run";
  if (operation === "notify_weekly_reminder") return "发送审核提醒";
  if (operation === "query_weekly_status") return "查询本期状态";
  return "执行 Git 同步";
}

function resolveStatusEchoText(statusEcho: FeishuActionStatusEcho | undefined) {
  if (!statusEcho) {
    return "系统已记录本次动作。";
  }
  if (statusEcho.reviewStatus === "approved" || statusEcho.publishStatus === "published") {
    return "当前状态：本期已发布。";
  }
  if (statusEcho.reviewStatus === "rejected") {
    return "当前状态：本轮已拒绝发布，需要新建 run 才能继续。";
  }
  if (statusEcho.reviewStage === "final_review") {
    return "当前状态：已进入终稿审核。";
  }
  return "当前状态：等待后续审核动作。";
}

function isSemanticallyDuplicatedReviewAction(input: {
  latest: ReviewInstruction | null;
  current: ReviewInstruction;
  duplicateWindowSeconds: number;
}) {
  const latest = input.latest;
  if (!latest) {
    return false;
  }
  if (latest.source !== "feishu_callback") {
    return false;
  }
  if (latest.action !== input.current.action) {
    return false;
  }

  const latestAt = dayjs(latest.decidedAt).valueOf();
  const currentAt = dayjs(input.current.decidedAt).valueOf();
  if (!Number.isFinite(latestAt) || !Number.isFinite(currentAt)) {
    return false;
  }
  const deltaMs = Math.abs(currentAt - latestAt);
  if (deltaMs > input.duplicateWindowSeconds * 1000) {
    return false;
  }

  // 指纹刻意忽略 operator/traceId/messageId，避免同一次点击因回调格式差异被误判为不同动作。
  return buildReviewActionSemanticFingerprint(latest) === buildReviewActionSemanticFingerprint(input.current);
}

function buildReviewActionSemanticFingerprint(input: Pick<ReviewInstruction, "reportDate" | "stage" | "action" | "reason" | "feedback">) {
  return stableJsonStringify({
    reportDate: input.reportDate,
    stage: input.stage,
    action: input.action ?? null,
    reason: input.reason?.trim() || null,
    feedback: input.feedback ?? null,
  });
}

function stableJsonStringify(input: unknown): string {
  if (Array.isArray(input)) {
    return `[${input.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(input);
}

function buildReviewMainCard(input: {
  reportDate: string;
  stage: FeishuMainCardRecord["stage"];
  stageLabel: string;
  guide: string;
  deadlineLabel: string;
  reviewUrl: string | null;
  publishedUrl: string | null;
  showDebug: boolean;
  debugFields: Record<string, string>;
}) {
  const linkLines = [
    input.reviewUrl ? `[查看待审核稿](${input.reviewUrl})` : "待审核稿链接未配置",
    input.publishedUrl ? `[查看已发布稿](${input.publishedUrl})` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const contentLines = [
    `**当前状态**：${input.stageLabel}`,
    `**下一步**：${input.guide}`,
    `**截止时间**：${input.deadlineLabel}（Asia/Shanghai）`,
    linkLines,
  ];
  if (input.showDebug) {
    const debugPairs = Object.entries(input.debugFields).map(([key, value]) => `- ${key}: ${value}`);
    contentLines.push("", "**debug**", ...debugPairs);
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: `AI 周报审核任务 ${input.reportDate}`,
      },
    },
    elements: [
      {
        tag: "markdown",
        content: contentLines.join("\n"),
      },
      {
        tag: "action",
        actions: buildStageActions(input.stage, input.reportDate),
      },
    ],
  };
}

function buildStageActions(stage: FeishuMainCardRecord["stage"], reportDate: string) {
  if (stage === "outline_review") {
    return [
      makeCardButton("大纲通过", "approve_outline", reportDate, "primary", "大纲通过"),
      makeCardButton("要求修订", "request_revision", reportDate, "default", "大纲需调整"),
      makeCardButton("拒绝本次", "reject", reportDate, "danger", "大纲拒绝"),
    ];
  }
  if (stage === "final_review") {
    return [
      makeCardButton("终稿通过并发布", "approve_final", reportDate, "primary", "终稿通过"),
      makeCardButton("要求修订", "request_revision", reportDate, "default", "终稿需调整"),
      makeCardButton("拒绝本次", "reject", reportDate, "danger", "终稿拒绝"),
    ];
  }
  return [
    {
      tag: "button",
      text: { tag: "plain_text", content: "本轮已结束" },
      disabled: true,
      value: {
        action: "noop",
        reportDate,
      },
    },
  ];
}

function buildOperationControlCard(reportDate: string) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "turquoise",
      title: {
        tag: "plain_text",
        content: `AI 周报主动触发面板（${reportDate}）`,
      },
    },
    elements: [
      {
        tag: "markdown",
        content: [
          "**用途**：用于测试、补偿触发和排障。",
          "**执行方式**：点击后先受理入队，后台异步执行，完成后群内回执结果。",
          `**默认 reportDate**：${reportDate}`,
        ].join("\n"),
      },
      {
        tag: "action",
        actions: [
          makeOperationButton("生成周报（mock）", "run_weekly", reportDate, false, "primary"),
          makeOperationButton("执行 recheck", "recheck_weekly", reportDate, false, "default"),
          makeOperationButton("watchdog dry-run", "watchdog_weekly_dry_run", reportDate, true, "default"),
          makeOperationButton("发送审核提醒", "notify_weekly_reminder", reportDate, false, "default"),
          makeOperationButton("查询本期状态", "query_weekly_status", reportDate, false, "default"),
        ],
      },
    ],
  };
}

function makeCardButton(
  label: string,
  action: ReviewInstructionAction,
  reportDate: string,
  type: "primary" | "default" | "danger",
  reason: string,
) {
  return {
    tag: "button",
    type,
    text: {
      tag: "plain_text",
      content: label,
    },
    value: {
      action,
      reportDate,
      reason,
    },
  };
}

function makeOperationButton(
  label: string,
  operation: OperationJobType,
  reportDate: string,
  dryRun: boolean,
  type: "primary" | "default" | "danger",
) {
  return {
    tag: "button",
    type,
    text: {
      tag: "plain_text",
      content: label,
    },
    value: {
      operation,
      reportDate,
      dryRun,
      reason: `manual_operation:${operation}`,
    },
  };
}

function buildCallbackEventDedupeKey(
  kind: "mention" | "operation",
  input: {
    traceId?: string;
    messageId?: string;
    reportDate?: string;
    actionOrOperation: string;
  },
): string {
  if (input.traceId) {
    return `${kind}:trace:${input.traceId}`;
  }
  if (input.messageId) {
    return `${kind}:message:${input.messageId}`;
  }
  return `${kind}:semantic:${input.reportDate ?? "none"}:${input.actionOrOperation}`;
}

function isRecentDuplicateEvent(cache: Map<string, number>, key: string, windowSeconds: number): boolean {
  const now = Date.now();
  // 清理窗口外 key，避免常驻进程里去重缓存无限增长。
  for (const [itemKey, ts] of cache.entries()) {
    if (now - ts > windowSeconds * 1000) {
      cache.delete(itemKey);
    }
  }
  const existing = cache.get(key);
  if (existing && now - existing <= windowSeconds * 1000) {
    return true;
  }
  cache.set(key, now);
  return false;
}

function isRecentTimestamp(input: string, windowSeconds: number): boolean {
  const timestamp = dayjs(input).valueOf();
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  return Date.now() - timestamp <= windowSeconds * 1000;
}

function shortErrorMessage(message: string): string {
  if (message.length <= 80) {
    return message;
  }
  return `${message.slice(0, 77)}...`;
}

function findPathOverlap(baseSegments: string[], fileSegments: string[]): number {
  const max = Math.min(baseSegments.length, fileSegments.length);
  for (let size = max; size >= 1; size -= 1) {
    const baseTail = baseSegments.slice(baseSegments.length - size).join("/");
    const fileHead = fileSegments.slice(0, size).join("/");
    if (baseTail === fileHead) {
      return size;
    }
  }
  return 0;
}

function buildCallbackToastPayload(input: { success: boolean; content: string }) {
  // 飞书卡片回调支持 toast 字段，便于点击人在客户端立即看到处理结果。
  return {
    toast: {
      type: input.success ? "success" : "error",
      content: input.content,
    },
  };
}

async function appendCallbackAuditLog(
  logger: StartFeishuCallbackServerInput["auditLogger"] | undefined,
  event: FeishuCallbackAuditEvent,
) {
  if (!logger) {
    return;
  }

  try {
    await logger(event);
  } catch (error) {
    // 审计写入失败仅记录 warning，避免影响回调主流程可用性。
    console.log(`[feishu-callback-audit-warning] ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const __test__ = {
  parseCallbackBody,
  adaptFeishuCardActionPayload,
  extractMentionEvent,
  buildOperationControlCard,
  verifyCallbackAuth,
  inferActionStatusEcho,
  hasAppConfig,
  buildCallbackToastPayload,
  isRecentDuplicateEvent,
  buildCallbackEventDedupeKey,
  clearTenantTokenCache: () => tenantTokenCache.clear(),
};
