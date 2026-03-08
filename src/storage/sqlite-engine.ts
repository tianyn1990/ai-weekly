import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import initSqlJs from "sql.js";

const require = createRequire(import.meta.url);
const wasmFilePath = require.resolve("sql.js/dist/sql-wasm.wasm");
type SqlJsDatabase = initSqlJs.Database;
type SqlBindParams = initSqlJs.BindParams;
type SqliteParams = SqlBindParams | Record<string, unknown>;

const loadSqlJsPromise = initSqlJs({
  // Node 环境下显式指定 wasm 文件路径，避免不同运行目录导致加载失败。
  locateFile: () => wasmFilePath,
});

const perFileLocks = new Map<string, Promise<void>>();

export interface SqliteReadContext {
  run(sql: string, params?: SqliteParams): void;
  queryOne<T extends Record<string, unknown>>(sql: string, params?: SqliteParams): T | null;
  queryMany<T extends Record<string, unknown>>(sql: string, params?: SqliteParams): T[];
}

export class SqliteEngine {
  constructor(private readonly dbPath: string) {}

  async read<T>(work: (ctx: SqliteReadContext) => T): Promise<T> {
    return withFileLock(this.dbPath, async () => {
      const db = await openDb(this.dbPath);
      try {
        ensureSchema(db);
        return work(createContext(db));
      } finally {
        db.close();
      }
    });
  }

  async write<T>(work: (ctx: SqliteReadContext) => T): Promise<T> {
    return withFileLock(this.dbPath, async () => {
      const db = await openDb(this.dbPath);
      try {
        ensureSchema(db);
        db.run("BEGIN");
        try {
          const result = work(createContext(db));
          db.run("COMMIT");
          await persistDb(this.dbPath, db);
          return result;
        } catch (error) {
          db.run("ROLLBACK");
          throw error;
        }
      } finally {
        db.close();
      }
    });
  }
}

function createContext(db: SqlJsDatabase): SqliteReadContext {
  return {
    run(sql, params) {
      db.run(sql, normalizeParams(params));
    },
    queryOne<T extends Record<string, unknown>>(sql: string, params?: SqliteParams) {
      const statement = db.prepare(sql, normalizeParams(params));
      try {
        if (!statement.step()) {
          return null;
        }
        return statement.getAsObject() as T;
      } finally {
        statement.free();
      }
    },
    queryMany<T extends Record<string, unknown>>(sql: string, params?: SqliteParams) {
      const statement = db.prepare(sql, normalizeParams(params));
      try {
        const rows: T[] = [];
        while (statement.step()) {
          rows.push(statement.getAsObject() as T);
        }
        return rows;
      } finally {
        statement.free();
      }
    },
  };
}

function normalizeParams(params?: SqliteParams): SqlBindParams {
  if (!params) {
    return null;
  }
  return params as SqlBindParams;
}

async function openDb(filePath: string): Promise<SqlJsDatabase> {
  const SQL = await loadSqlJsPromise;
  try {
    const buffer = await fs.readFile(filePath);
    return new SQL.Database(new Uint8Array(buffer));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new SQL.Database();
    }
    throw error;
  }
}

async function persistDb(filePath: string, db: SqlJsDatabase): Promise<void> {
  const binary = db.export();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(binary));
}

async function withFileLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = perFileLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  perFileLocks.set(key, previous.then(() => current));

  await previous;
  try {
    return await task();
  } finally {
    release();
    if (perFileLocks.get(key) === current) {
      perFileLocks.delete(key);
    }
  }
}

function ensureSchema(db: SqlJsDatabase) {
  db.run(`
    CREATE TABLE IF NOT EXISTS review_instructions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      report_date TEXT NOT NULL,
      run_id TEXT,
      stage TEXT NOT NULL,
      action TEXT,
      approved INTEGER,
      decided_at TEXT NOT NULL,
      source TEXT,
      operator TEXT,
      reason TEXT,
      trace_id TEXT,
      message_id TEXT,
      feedback_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_review_instruction_lookup
    ON review_instructions(mode, report_date, stage, decided_at DESC, id DESC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_review_instruction_trace
    ON review_instructions(trace_id);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS runtime_config_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      trace_id TEXT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      operator TEXT,
      source TEXT,
      trace_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_audit_event_type_time
    ON audit_events(event_type, created_at DESC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_audit_event_trace
    ON audit_events(trace_id);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS operation_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      dedupe_key TEXT,
      created_by TEXT,
      source TEXT,
      trace_id TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_operation_job_pick
    ON operation_jobs(status, created_at ASC, id ASC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_operation_job_trace
    ON operation_jobs(trace_id);
  `);
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_job_dedupe
    ON operation_jobs(dedupe_key)
    WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running');
  `);
}
