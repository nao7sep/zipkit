/**
 * The thread that owns `records.sqlite3` (logging and data-lifecycle conventions,
 * Records): the main process posts each record here, so a slow or locked database
 * never holds the interface. It answers every write with `written` or `failed`;
 * the main process keeps the fallback file. It imports only Node built-ins, so the
 * tests run this source as it is.
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

export type RecordsRequest =
  | { type: "log"; id: number; row: LogRow }
  | { type: "close" };

export type RecordsResponse =
  | { type: "written"; id: number }
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
`;

/** An error as plain data for the main process's log: its own fields (SQLite's
 *  `code` and `errcode`) plus name, message and stack. */
function errorData(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) };
  return { ...err, name: err.name, message: err.message, stack: err.stack };
}

class RecordsStore {
  #db: DatabaseSync | null = null;
  #insertLog: StatementSync | null = null;
  #openFailure: unknown = null;
  readonly #database: string;

  constructor(database: string) {
    this.#database = database;
  }

  /** Opened on the first record, so a process that never logs creates no
   *  database; a failed open is not retried. */
  #open(): StatementSync {
    if (this.#insertLog) return this.#insertLog;
    if (this.#openFailure !== null) throw this.#openFailure;
    try {
      mkdirSync(path.dirname(this.#database), { recursive: true });
      const db = new DatabaseSync(this.#database);
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(SCHEMA);
      this.#db = db;
      this.#insertLog = db.prepare(
        "INSERT INTO logs (time_utc, session_utc, level, message, job_id, fields) VALUES (?, ?, ?, ?, ?, ?)",
      );
      return this.#insertLog;
    } catch (err) {
      this.#openFailure = err;
      throw err;
    }
  }

  log(row: LogRow): void {
    this.#open().run(row.time, row.session, row.level, row.message, row.jobId, row.fields);
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
    this.#insertLog = null;
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
      store.log(request.row);
      reply({ type: "written", id: request.id });
    } catch (err) {
      reply({ type: "failed", id: request.id, error: errorData(err) });
    }
  });
}
