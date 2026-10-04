/**
 * The thread that owns `records.sqlite3` (logging and data-lifecycle conventions,
 * Records): the main process posts each record and each read here, so a slow or
 * locked database never holds the interface. It answers every write with
 * `written` or `failed`; the main process keeps the fallback file. Its only
 * imports at run time are Node built-ins (the shared records types are erased),
 * so the tests run this source as it is.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type { RecordDetail, RecordKind, RecordsPage, RecordsQuery, RecordSummary } from "../shared/records.js";

export interface RecordsWorkerData {
  database: string;
}

/** One log line. `session` is the launch's start; `jobId` is the queue job the
 *  line names, if any; `fields` is the caller's structured object as JSON. */
export interface LogRow {
  time: string;
  session: string;
  level: string;
  message: string;
  jobId: string | null;
  fields: string;
}

/** One SDK progress event under the queue job it ran for. `seq` numbers the
 *  session's events in the order they were sent to the window; `body` is the
 *  SDK's event whole, as JSON. */
export interface JobEventRow {
  time: string;
  session: string;
  seq: number;
  jobId: string;
  /** The action that started the event's run, and the run's id in the session. */
  action: string;
  run: string;
  event: string;
  level: string;
  body: string;
}

export type StoredJobEventRow = Pick<JobEventRow, "session" | "seq" | "action" | "run" | "body">;

/** What the Records window asks of the database. Reads go through the same
 *  thread as writes, so a read sees every entry posted before it. */
export type RecordsRead =
  | { op: "page"; query: RecordsQuery; pageSize: number }
  | { op: "detail"; kind: RecordKind; id: number }
  | { op: "sessions" };

export interface RecordsReadResults {
  page: RecordsPage;
  detail: RecordDetail | null;
  sessions: string[];
}

export type RecordsRequest =
  | { type: "log"; id: number; row: LogRow }
  | { type: "jobEvent"; id: number; row: JobEventRow }
  | { type: "readJobEvents"; id: number; jobId: string; limit: number }
  | { type: "readRecords"; id: number; read: RecordsRead }
  | { type: "close" };

export type RecordsResponse =
  | { type: "written"; id: number }
  | { type: "read"; id: number; rows: StoredJobEventRow[] }
  | { type: "records"; id: number; value: RecordsReadResults[RecordsRead["op"]] }
  | { type: "failed"; id: number; error: Record<string, unknown> }
  | { type: "closed" };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY,
  time_utc    TEXT NOT NULL,
  session_utc TEXT NOT NULL,
  level       TEXT NOT NULL,
  message     TEXT NOT NULL,
  job_id      TEXT,
  fields      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_session ON logs (session_utc, id);
CREATE INDEX IF NOT EXISTS idx_logs_job ON logs (job_id, id) WHERE job_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS job_events (
  id          INTEGER PRIMARY KEY,
  time_utc    TEXT NOT NULL,
  session_utc TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  job_id      TEXT NOT NULL,
  action      TEXT NOT NULL,
  run         TEXT NOT NULL,
  event       TEXT NOT NULL,
  level       TEXT NOT NULL,
  body        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events (job_id, id);
CREATE INDEX IF NOT EXISTS idx_logs_time ON logs (time_utc, id);
CREATE INDEX IF NOT EXISTS idx_job_events_time ON job_events (time_utc, id);
`;

/** An error as plain data for the main process's log: its own fields (SQLite's
 *  `code` and `errcode`) plus name, message and stack. */
function errorData(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) };
  return { ...err, name: err.name, message: err.message, stack: err.stack };
}

// The Records window's reads. Each kind is read from its own table in the
// window's order (time, then kind, then id, newest first) and only as far as
// one page, through its time index, so a page costs the same however many
// records a long history holds; the two are then merged.

interface RecordTable {
  kind: RecordKind;
  table: string;
  select: string;
  searched: readonly string[];
}

const RECORD_TABLES: readonly RecordTable[] = [
  {
    kind: "log",
    table: "logs",
    select:
      "SELECT 'log' AS kind, id, session_utc AS session, time_utc AS time, level, message AS title, NULL AS text, job_id AS jobId",
    searched: ["message", "job_id", "fields"],
  },
  {
    kind: "job-event",
    table: "job_events",
    select:
      "SELECT 'job-event' AS kind, id, session_utc AS session, time_utc AS time, level, event AS title, json_extract(body, '$.message') AS text, job_id AS jobId",
    searched: ["event", "job_id", "body"],
  },
];

function likePattern(search: string): string | null {
  const trimmed = search.trim();
  return trimmed === "" ? null : `%${trimmed.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/** One page of summaries, newest first, after the query's cursor. */
export function readRecordsPage(db: DatabaseSync, query: RecordsQuery, pageSize: number): RecordsPage {
  const pattern = likePattern(query.search);
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  for (const { kind, table, select, searched } of RECORD_TABLES) {
    if (query.kind !== null && query.kind !== kind) continue;
    const where = ["1 = 1"];
    if (query.session !== null) {
      where.push("session_utc = ?");
      params.push(query.session);
    }
    if (query.level === "attention") {
      where.push("level IN ('warn', 'error')");
    } else if (query.level !== null) {
      where.push("level = ?");
      params.push(query.level);
    }
    if (pattern !== null) {
      where.push(`(${searched.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
      params.push(...searched.map(() => pattern));
    }
    // A row comes after the cursor when (time, kind, id) is smaller; this
    // table's kind is fixed, so the comparison reduces to time and id.
    const after = query.after;
    if (after !== null) {
      if (kind < after.kind) {
        where.push("time_utc <= ?");
        params.push(after.time);
      } else if (kind > after.kind) {
        where.push("time_utc < ?");
        params.push(after.time);
      } else {
        where.push("(time_utc < ? OR (time_utc = ? AND id < ?))");
        params.push(after.time, after.time, after.id);
      }
    }
    parts.push(
      `SELECT * FROM (${select} FROM ${table} WHERE ${where.join(" AND ")} ORDER BY time_utc DESC, id DESC LIMIT ?)`,
    );
    params.push(pageSize + 1);
  }
  if (parts.length === 0) return { records: [], more: false };
  params.push(pageSize + 1);
  const rows = db
    .prepare(`SELECT * FROM (${parts.join(" UNION ALL ")}) ORDER BY time DESC, kind DESC, id DESC LIMIT ?`)
    .all(...params) as unknown as RecordSummary[];
  return { records: rows.slice(0, pageSize), more: rows.length > pageSize };
}

/** One record whole, every field as the database holds it. */
export function readRecordDetail(db: DatabaseSync, kind: RecordKind, id: number): RecordDetail | null {
  const row =
    kind === "log"
      ? db
          .prepare(
            "SELECT 'log' AS kind, id, session_utc AS session, time_utc AS time, level, message, job_id AS jobId, fields FROM logs WHERE id = ?",
          )
          .get(id)
      : db
          .prepare(
            "SELECT 'job-event' AS kind, id, session_utc AS session, time_utc AS time, seq, job_id AS jobId, event, level, body FROM job_events WHERE id = ?",
          )
          .get(id);
  return (row as unknown as RecordDetail | undefined) ?? null;
}

/** Every launch that has records, newest first. */
export function readRecordSessions(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT session_utc AS session FROM logs UNION SELECT session_utc FROM job_events ORDER BY session DESC")
    .all() as { session: string }[];
  return rows.map((row) => row.session);
}

interface Statements {
  insertLog: StatementSync;
  insertJobEvent: StatementSync;
  selectJobEvents: StatementSync;
}

class RecordsStore {
  #db: DatabaseSync | null = null;
  #statements: Statements | null = null;
  #openFailure: unknown = null;
  readonly #database: string;

  constructor(database: string) {
    this.#database = database;
  }

  /** Opened on the first request, so a process that never logs creates no
   *  database; a failed open is not retried. */
  #open(): Statements {
    if (this.#statements) return this.#statements;
    if (this.#openFailure !== null) throw this.#openFailure;
    try {
      mkdirSync(path.dirname(this.#database), { recursive: true });
      const db = new DatabaseSync(this.#database);
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(SCHEMA);
      this.#db = db;
      this.#statements = {
        insertLog: db.prepare(
          "INSERT INTO logs (time_utc, session_utc, level, message, job_id, fields) VALUES (?, ?, ?, ?, ?, ?)",
        ),
        insertJobEvent: db.prepare(
          "INSERT INTO job_events (time_utc, session_utc, seq, job_id, action, run, event, level, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ),
        // The newest `limit` events, oldest first.
        selectJobEvents: db.prepare(
          "SELECT session, seq, action, run, body FROM (SELECT id, session_utc AS session, seq, action, run, body FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
        ),
      };
      return this.#statements;
    } catch (err) {
      this.#openFailure = err;
      throw err;
    }
  }

  log(row: LogRow): void {
    this.#open().insertLog.run(row.time, row.session, row.level, row.message, row.jobId, row.fields);
  }

  jobEvent(row: JobEventRow): void {
    this.#open().insertJobEvent.run(
      row.time,
      row.session,
      row.seq,
      row.jobId,
      row.action,
      row.run,
      row.event,
      row.level,
      row.body,
    );
  }

  readJobEvents(jobId: string, limit: number): StoredJobEventRow[] {
    return this.#open().selectJobEvents.all(jobId, limit) as unknown as StoredJobEventRow[];
  }

  readRecords(read: RecordsRead): RecordsReadResults[RecordsRead["op"]] {
    this.#open();
    const db = this.#db!;
    if (read.op === "page") return readRecordsPage(db, read.query, read.pageSize);
    if (read.op === "detail") return readRecordDetail(db, read.kind, read.id);
    return readRecordSessions(db);
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
    this.#statements = null;
  }
}

function answer(store: RecordsStore, request: Exclude<RecordsRequest, { type: "close" }>): RecordsResponse {
  switch (request.type) {
    case "log":
      store.log(request.row);
      return { type: "written", id: request.id };
    case "jobEvent":
      store.jobEvent(request.row);
      return { type: "written", id: request.id };
    case "readJobEvents":
      return { type: "read", id: request.id, rows: store.readJobEvents(request.jobId, request.limit) };
    case "readRecords":
      return { type: "records", id: request.id, value: store.readRecords(request.read) };
  }
}

if (parentPort) {
  const port = parentPort;
  const store = new RecordsStore((workerData as RecordsWorkerData).database);
  const reply = (response: RecordsResponse): void => port.postMessage(response);
  port.on("message", (request: RecordsRequest) => {
    if (request.type === "close") {
      try {
        store.close();
      } finally {
        reply({ type: "closed" });
        port.close();
      }
      return;
    }
    try {
      reply(answer(store, request));
    } catch (err) {
      reply({ type: "failed", id: request.id, error: errorData(err) });
    }
  });
}
