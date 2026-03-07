import { z } from "zod";

import { SqliteEngine } from "../storage/sqlite-engine.js";

export interface AuditEvent {
  id?: number;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  operator?: string;
  source?: string;
  traceId?: string;
  createdAt: string;
}

export interface AuditEventQuery {
  traceId?: string;
  eventType?: string;
  from?: string;
  to?: string;
  limit?: number;
}

const auditRowSchema = z.object({
  id: z.number(),
  event_type: z.string(),
  entity_type: z.string(),
  entity_id: z.string(),
  payload_json: z.string(),
  operator: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  trace_id: z.string().nullable().optional(),
  created_at: z.string(),
});

export class DbAuditStore {
  constructor(private readonly engine: SqliteEngine) {}

  async append(event: AuditEvent): Promise<number> {
    return this.engine.write((ctx) => {
      ctx.run(
        `
        INSERT INTO audit_events (
          event_type, entity_type, entity_id, payload_json, operator, source, trace_id, created_at
        ) VALUES (
          $eventType, $entityType, $entityId, $payloadJson, $operator, $source, $traceId, $createdAt
        );
        `,
        {
          $eventType: event.eventType,
          $entityType: event.entityType,
          $entityId: event.entityId,
          $payloadJson: JSON.stringify(event.payload),
          $operator: event.operator ?? null,
          $source: event.source ?? null,
          $traceId: event.traceId ?? null,
          $createdAt: event.createdAt,
        },
      );

      const row = ctx.queryOne<{ id: number }>("SELECT CAST(last_insert_rowid() AS INTEGER) AS id;");
      return row?.id ?? 0;
    });
  }

  async query(input: AuditEventQuery): Promise<AuditEvent[]> {
    return this.engine.read((ctx) => {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
      const where: string[] = [];
      const params: Record<string, unknown> = { $limit: limit };
      if (input.traceId) {
        where.push("trace_id = $traceId");
        params.$traceId = input.traceId;
      }
      if (input.eventType) {
        where.push("event_type = $eventType");
        params.$eventType = input.eventType;
      }
      if (input.from) {
        where.push("created_at >= $from");
        params.$from = input.from;
      }
      if (input.to) {
        where.push("created_at <= $to");
        params.$to = input.to;
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const rows = ctx.queryMany(
        `
        SELECT id, event_type, entity_type, entity_id, payload_json, operator, source, trace_id, created_at
        FROM audit_events
        ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $limit;
        `,
        params,
      );
      return rows.map((row) => toAuditEvent(auditRowSchema.parse(row)));
    });
  }
}

function toAuditEvent(row: z.infer<typeof auditRowSchema>): AuditEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    operator: row.operator ?? undefined,
    source: row.source ?? undefined,
    traceId: row.trace_id ?? undefined,
    createdAt: row.created_at,
  };
}
