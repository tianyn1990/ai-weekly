import fs from "node:fs/promises";
import path from "node:path";
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";

import { z } from "zod";

import type { DbAuditStore } from "../audit/audit-store.js";
import { RuntimeConfigVersionConflictError, type RuntimeConfigStore } from "../config/runtime-config.js";
import { reviewArtifactSchema } from "../core/review-artifact.js";
import type { ReviewInstructionStore } from "./instruction-store.js";

export interface StartReviewApiServerInput {
  host: string;
  port: number;
  authToken?: string;
  outputRoot: string;
  reviewStore: ReviewInstructionStore;
  runtimeStore: RuntimeConfigStore;
  auditStore: DbAuditStore;
}

const reviewActionSchema = z.object({
  mode: z.enum(["daily", "weekly"]),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  runId: z.string().min(1).optional(),
  stage: z.enum(["outline_review", "final_review"]),
  action: z.enum(["approve_outline", "approve_final", "request_revision", "reject"]).optional(),
  approved: z.boolean().optional(),
  decidedAt: z.string().datetime(),
  source: z.enum(["cli", "feishu_callback", "api"]).default("api"),
  operator: z.string().min(1).optional(),
  reason: z.string().optional(),
  traceId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  feedback: z.record(z.string(), z.unknown()).optional(),
});

const runtimePatchSchema = z.object({
  expectedVersion: z.number().int().min(0),
  operator: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  patch: z
    .object({
      topics: z.array(z.string().min(1)).optional(),
      searchTerms: z.array(z.string().min(1)).optional(),
      sourceToggles: z.record(z.string().min(1), z.boolean()).optional(),
      sourceWeights: z.record(z.string().min(1), z.number().min(1).max(100)).optional(),
      rankingWeights: z
        .object({
          source: z.number().min(0).max(3).optional(),
          freshness: z.number().min(0).max(3).optional(),
          keyword: z.number().min(0).max(3).optional(),
        })
        .optional(),
    })
    .strict(),
});

export async function startReviewApiServer(input: StartReviewApiServerInput): Promise<{
  close: () => Promise<void>;
  port: number;
}> {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && getPath(req.url) === "/health") {
        return sendJson(res, 200, { ok: true });
      }

      verifyApiAuth(req.headers, input.authToken);
      const method = req.method ?? "GET";
      const requestPath = getPath(req.url);

      if (method === "POST" && requestPath === "/api/review-actions") {
        const body = reviewActionSchema.parse(await readJsonBody(req));
        await input.reviewStore.appendInstruction({
          mode: body.mode,
          reportDate: body.reportDate,
          runId: body.runId,
          stage: body.stage,
          action: body.action,
          approved: body.approved,
          decidedAt: body.decidedAt,
          source: body.source,
          operator: body.operator,
          reason: body.reason,
          traceId: body.traceId,
          messageId: body.messageId,
          feedback: body.feedback as any,
        });
        return sendJson(res, 200, { ok: true });
      }

      if (method === "GET" && requestPath === "/api/review-actions/latest") {
        const query = getQuery(req.url);
        const mode = query.mode === "daily" || query.mode === "weekly" ? query.mode : "weekly";
        const reportDate = query.reportDate;
        const stage = query.stage === "outline_review" || query.stage === "final_review" ? query.stage : null;
        if (!reportDate || !stage) {
          return sendJson(res, 400, { ok: false, error: "missing_report_date_or_stage" });
        }

        const instruction = await input.reviewStore.getLatestInstruction({
          mode,
          reportDate,
          stage,
          decidedAfterOrAt: query.reviewStartedAt,
        });
        return sendJson(res, 200, { ok: true, instruction });
      }

      if (method === "GET" && requestPath === "/api/review/pending") {
        const pending = await loadPendingWeekly(input.outputRoot);
        return sendJson(res, 200, { ok: true, items: pending });
      }

      if (method === "GET" && requestPath === "/api/runtime-config") {
        const current = await input.runtimeStore.getCurrent();
        return sendJson(res, 200, { ok: true, ...current });
      }

      if (method === "PATCH" && requestPath === "/api/runtime-config") {
        const body = runtimePatchSchema.parse(await readJsonBody(req));
        const current = await input.runtimeStore.getCurrent();
        const nowIso = new Date().toISOString();
        const nextConfig = applyRuntimePatch(current.config, body.patch, nowIso);
        const saved = await input.runtimeStore.saveNext({
          expectedVersion: body.expectedVersion,
          config: nextConfig,
          updatedAt: nowIso,
          updatedBy: body.operator,
          traceId: body.traceId,
        });
        return sendJson(res, 200, { ok: true, ...saved });
      }

      if (method === "GET" && requestPath === "/api/audit-events") {
        const query = getQuery(req.url);
        const events = await input.auditStore.query({
          traceId: query.traceId,
          eventType: query.eventType,
          from: query.from,
          to: query.to,
          limit: query.limit ? Number(query.limit) : undefined,
        });
        return sendJson(res, 200, { ok: true, items: events });
      }

      return sendJson(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      if (error instanceof RuntimeConfigVersionConflictError) {
        return sendJson(res, 409, {
          ok: false,
          error: "runtime_config_version_conflict",
          expectedVersion: error.expectedVersion,
          actualVersion: error.actualVersion,
        });
      }
      return sendJson(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
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
    throw new Error("review_api_server_start_failed");
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

function verifyApiAuth(headers: IncomingHttpHeaders, authToken?: string) {
  if (!authToken) {
    return;
  }
  const value = headers.authorization;
  const token = Array.isArray(value) ? value[0] : value;
  if (token !== `Bearer ${authToken}`) {
    throw new Error("unauthorized:invalid_api_token");
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function sendJson(res: import("node:http").ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function getPath(url: string | undefined): string {
  try {
    return new URL(`http://localhost${url ?? ""}`).pathname;
  } catch {
    return "/";
  }
}

function getQuery(url: string | undefined): Record<string, string> {
  try {
    const parsed = new URL(`http://localhost${url ?? ""}`);
    return Object.fromEntries(parsed.searchParams.entries());
  } catch {
    return {};
  }
}

async function loadPendingWeekly(outputRoot: string) {
  const dir = path.join(outputRoot, "weekly");
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const rows: Array<{ reportDate: string; reviewStatus: string; reviewStage: string; reviewDeadlineAt: string | null }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const reportDate = name.replace(/\.json$/, "");
    const content = await fs.readFile(path.join(dir, name), "utf-8");
    const artifact = reviewArtifactSchema.parse(JSON.parse(content));
    if (artifact.mode !== "weekly") {
      continue;
    }
    if (artifact.reviewStatus !== "pending_review" || artifact.publishStatus !== "pending") {
      continue;
    }
    rows.push({
      reportDate: artifact.reportDate ?? reportDate,
      reviewStatus: artifact.reviewStatus,
      reviewStage: artifact.reviewStage,
      reviewDeadlineAt: artifact.reviewDeadlineAt,
    });
  }
  return rows.sort((a, b) => a.reportDate.localeCompare(b.reportDate));
}

function applyRuntimePatch(
  current: Awaited<ReturnType<RuntimeConfigStore["getCurrent"]>>["config"],
  patch: z.infer<typeof runtimePatchSchema>["patch"],
  nowIso: string,
) {
  const next = JSON.parse(JSON.stringify(current)) as typeof current;
  if (patch.topics) {
    next.topics = patch.topics;
  }
  if (patch.searchTerms) {
    next.searchTerms = patch.searchTerms;
  }
  if (patch.sourceToggles) {
    next.sourceToggles = patch.sourceToggles;
  }
  if (patch.sourceWeights) {
    next.sourceWeights = patch.sourceWeights;
  }
  if (patch.rankingWeights) {
    next.rankingWeights = {
      source: patch.rankingWeights.source ?? next.rankingWeights.source,
      freshness: patch.rankingWeights.freshness ?? next.rankingWeights.freshness,
      keyword: patch.rankingWeights.keyword ?? next.rankingWeights.keyword,
    };
  }
  next.updatedAt = nowIso;
  return next;
}
