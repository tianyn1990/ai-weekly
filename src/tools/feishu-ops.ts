#!/usr/bin/env node

import dayjs from "dayjs";
import { z } from "zod";
import { pathToFileURL } from "node:url";

interface CliArgs {
  command: "token" | "chats" | "send-card";
  chatName?: string;
  chatId?: string;
  reportDate?: string;
  title?: string;
}

interface FeishuTenantTokenResponse {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

interface FeishuChatListResponse {
  code: number;
  msg?: string;
  data?: {
    has_more?: boolean;
    page_token?: string;
    items?: Array<{
      chat_id: string;
      name: string;
      description?: string;
    }>;
  };
}

interface FeishuSendMessageResponse {
  code: number;
  msg?: string;
  data?: {
    message_id?: string;
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "token") {
    await runTokenCommand();
    return;
  }
  if (args.command === "chats") {
    await runChatsCommand(args);
    return;
  }
  await runSendCardCommand(args);
}

async function runTokenCommand() {
  const token = await fetchTenantAccessToken();
  console.log(token);
}

async function runChatsCommand(args: CliArgs) {
  const token = await fetchTenantAccessToken();
  const chats = await listChats(token);
  const filtered = args.chatName
    ? chats.filter((chat) => chat.name.toLowerCase().includes(args.chatName!.toLowerCase()))
    : chats;

  if (filtered.length === 0) {
    console.log("[feishu-chats] no chats found.");
    return;
  }

  for (const chat of filtered) {
    console.log(`${chat.name}\t${chat.chat_id}`);
  }

  if (filtered.length === 1) {
    console.log(`[feishu-chats] suggestion: export REVIEW_CHAT_ID="${filtered[0].chat_id}"`);
  }
}

async function runSendCardCommand(args: CliArgs) {
  const chatId = args.chatId ?? process.env.REVIEW_CHAT_ID;
  if (!chatId) {
    throw new Error("缺少 chat_id：请通过 --chat-id 传入或设置环境变量 REVIEW_CHAT_ID");
  }

  const reportDate = args.reportDate ?? dayjs().format("YYYY-MM-DD");
  const title = args.title ?? `AI 周报审核 ${reportDate}`;
  const card = buildReviewCard({ reportDate, title });

  const token = await fetchTenantAccessToken();
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    }),
  });

  if (!response.ok) {
    throw new Error(`发送卡片失败（HTTP ${response.status}）`);
  }

  const payload = (await response.json()) as FeishuSendMessageResponse;
  if (payload.code !== 0) {
    throw new Error(`发送卡片失败（业务码 ${payload.code}）: ${payload.msg ?? "unknown_error"}`);
  }

  console.log(
    `[feishu-card] sent chatId=${chatId}, reportDate=${reportDate}, messageId=${payload.data?.message_id ?? "unknown"}`,
  );
}

async function fetchTenantAccessToken() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET，请先配置环境变量。");
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
    throw new Error(`获取 tenant_access_token 失败（HTTP ${response.status}）`);
  }

  const payload = (await response.json()) as FeishuTenantTokenResponse;
  if (payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败（业务码 ${payload.code}）: ${payload.msg ?? "unknown_error"}`);
  }

  return payload.tenant_access_token;
}

async function listChats(token: string) {
  const items: Array<{ chat_id: string; name: string; description?: string }> = [];
  let pageToken: string | undefined;
  let safetyCounter = 0;

  while (safetyCounter < 10) {
    safetyCounter += 1;
    const query = new URLSearchParams({
      page_size: "100",
      user_id_type: "open_id",
    });
    if (pageToken) {
      query.set("page_token", pageToken);
    }
    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats?${query.toString()}`, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`查询 chats 失败（HTTP ${response.status}）: ${detail}`);
    }

    const payload = (await response.json()) as FeishuChatListResponse;
    if (payload.code !== 0) {
      throw new Error(`查询 chats 失败（业务码 ${payload.code}）: ${payload.msg ?? "unknown_error"}`);
    }

    const current = payload.data?.items ?? [];
    items.push(...current);
    if (!payload.data?.has_more) {
      break;
    }
    pageToken = payload.data?.page_token;
  }

  return items;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0) {
    throw new Error("缺少子命令：可选 token | chats | send-card");
  }

  const command = argv[0];
  if (command !== "token" && command !== "chats" && command !== "send-card") {
    throw new Error(`未知子命令: ${command}`);
  }

  const args: CliArgs = { command };
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === "--chat-name" && next) {
      args.chatName = next;
      i += 1;
      continue;
    }
    if (token === "--chat-id" && next) {
      args.chatId = next;
      i += 1;
      continue;
    }
    if (token === "--report-date" && next) {
      args.reportDate = dateStringSchema.parse(next);
      i += 1;
      continue;
    }
    if (token === "--title" && next) {
      args.title = next;
      i += 1;
      continue;
    }
  }
  return args;
}

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function buildReviewCard(input: { reportDate: string; title: string }) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: input.title,
      },
    },
    elements: [
      {
        tag: "markdown",
        content: `请点击审核动作，reportDate=${input.reportDate}`,
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "大纲通过" },
            value: {
              action: "approve_outline",
              reportDate: input.reportDate,
              reason: "from_feishu_click",
            },
          },
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "终稿通过" },
            value: {
              action: "approve_final",
              reportDate: input.reportDate,
              reason: "from_feishu_click",
            },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "打回修订" },
            value: {
              action: "request_revision",
              reportDate: input.reportDate,
              reason: "need_revision",
            },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "拒绝发布" },
            value: {
              action: "reject",
              reportDate: input.reportDate,
              reason: "reject_this_round",
            },
          },
        ],
      },
    ],
  };
}

export const __test__ = {
  parseArgs,
  buildReviewCard,
};

if (isExecutedAsCli()) {
  main().catch((error) => {
    console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

function isExecutedAsCli() {
  const argvPath = process.argv[1];
  if (!argvPath) {
    return false;
  }
  return import.meta.url === pathToFileURL(argvPath).href;
}
