/**
 * The thread that owns `records.sqlite3` (logging and data-lifecycle conventions,
 * Records): the main process posts each record and each read here, so a slow or
 * locked database never holds the interface. It answers every write with
 * `written` or `failed`; the main process keeps the fallback file. It imports only
 * Node built-ins, so the tests run this source as it is.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

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
  event: string;
  level: string;
  body: string;
}

export type StoredJobEventRow = Pick<JobEventRow, "session" | "seq" | "body">;

export type RecordsRequest =
  | { type: "log"; id: number; row: LogRow }
  | { type: "jobEvent"; id: number; row: JobEventRow }
  | { type: "readJobEvents"; id: number; jobId: string; limit: number }
  | { type: "close" };

export type RecordsResponse =
  | { type: "written"; id: number }
  | { type: "read"; id: number; rows: StoredJobEventRow[] }
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
  event       TEXT NOT NULL,
  level       TEXT NOT NULL,
  body        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events (job_id, id);
`;

/** An error as plain data for the main process's log: its own fields (SQLite's
 *  `code` and `errcode`) plus name, message and stack. */
function errorData(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) };
  return { ...err, name: err.name, message: err.message, stack: err.stack };
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
          "INSERT INTO job_events (time_utc, session_utc, seq, job_id, event, level, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ),
        // The newest `limit` events, oldest first.
        selectJobEvents: db.prepare(
          "SELECT session, seq, body FROM (SELECT id, session_utc AS session, seq, body FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
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
    this.#open().insertJobEvent.run(row.time, row.session, row.seq, row.jobId, row.event, row.level, row.body);
  }

  readJobEvents(jobId: string, limit: number): StoredJobEventRow[] {
    return this.#open().selectJobEvents.all(jobId, limit) as unknown as StoredJobEventRow[];
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
