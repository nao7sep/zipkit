/**
 * The app's own log — the lifecycle-and-orchestration record the main process
 * keeps, per the logging and data-lifecycle conventions. It is distinct from
 * (and complementary to) the SDK instance's per-verb log file, which records
 * scan/plan/write/extract internals; each SDK result's `log` field names that
 * file. Here we record what the *app* does: startup/shutdown, IPC commands,
 * queue transitions, and failures.
 *
 * Each line is a row in `records.sqlite3` (logging and data-lifecycle
 * conventions); `debug` is gated by `ZIPKIT_DEBUG=1`. The main process is the
 * sole writer and the renderer forwards its entries over IPC.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { defaultLogDir, defaultSessionTimestamp } from "../../sdk/log/session.js";
import { storageRoot } from "../../sdk/storage.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface AppLog {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** A no-op logger: the default for the queue engine in tests and any context with
 *  no records database. */
export const nullLog: AppLog = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Serialize an error for logging — name, message, stack, and the cause chain, not
 * just `.message`. (An `Error`'s own properties are non-enumerable, so logging a
 * raw `Error` would stringify to `{}`.)
 */
export function errorInfo(err: unknown): LogFields {
  return errorInfoInner(err, new WeakSet());
}

function errorInfoInner(err: unknown, seen: WeakSet<Error>): LogFields {
  if (!(err instanceof Error)) return { value: String(err) };
  if (seen.has(err)) return { name: err.name, message: err.message, circular: true };
  seen.add(err);
  const info: LogFields = { ...err, name: err.name, message: err.message };
  if (err.stack) info.stack = err.stack;
  if (err.cause !== undefined) info.cause = errorInfoInner(err.cause, seen);
  if (err instanceof AggregateError) info.errors = err.errors.map((error) => errorInfoInner(error, seen));
  seen.delete(err);
  return info;
}

export interface SessionAppLog extends AppLog {
  /** The records database this session writes to. */
  readonly database: string;
}

/** `~/.zipkit/records.sqlite3` (or under `ZIPKIT_DATA_DIR`). */
export function defaultRecordsFile(): string {
  return path.join(storageRoot(), "records.sqlite3");
}

/**
 * One row per log line (data-lifecycle conventions, Records). `session_utc` is the
 * launch's start; `job_id` is the queue job the line names, if any; `fields` is
 * the caller's structured object as JSON.
 */
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

interface LogRecord {
  time: string;
  level: LogLevel;
  message: string;
  jobId: string | null;
  fields: string;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function serializeFields(fields: LogFields | undefined): string {
  try {
    return JSON.stringify(fields ?? {});
  } catch (err) {
    // A non-serializable field (a BigInt, a throwing toJSON) must not crash the
    // caller or lose the line.
    return JSON.stringify({ serializationError: reason(err) });
  }
}

/**
 * Open the app's log for this launch. Never throws: an entry the database cannot
 * take goes to this session's file under `logs/`, then to stderr (logging
 * conventions, When logging itself fails).
 */
export function createAppLog(
  databaseFile: string = defaultRecordsFile(),
  fallbackDir: string = process.env.ZIPKIT_LOG_DIR ?? defaultLogDir(),
  now: Date = new Date(),
): SessionAppLog {
  const session = now.toISOString();
  const fallbackFile = path.join(fallbackDir, `${defaultSessionTimestamp(now)}.log`);

  // Opened on the first entry, so a process that never logs creates no database.
  let insert: StatementSync | null | undefined;
  let databaseFailure: unknown = null;
  const openInsert = (): StatementSync | null => {
    if (insert !== undefined) return insert;
    try {
      mkdirSync(path.dirname(databaseFile), { recursive: true });
      const db = new DatabaseSync(databaseFile);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec(SCHEMA);
      insert = db.prepare(
        "INSERT INTO logs (time_utc, session_utc, level, message, job_id, fields) VALUES (?, ?, ?, ?, ?, ?)",
      );
    } catch (err) {
      databaseFailure = err;
      insert = null;
    }
    return insert;
  };

  let databaseFailureReported = false;
  let fallbackState: "closed" | "open" | "stderr" = "closed";

  const toStderr = (line: string): void => {
    try {
      process.stderr.write(line);
    } catch {
      /* the last resort is itself best-effort */
    }
  };

  const toFallback = (line: string): void => {
    if (fallbackState === "closed") {
      try {
        mkdirSync(fallbackDir, { recursive: true });
        // Exclusive create: a same-millisecond file another session already
        // holds is never appended into (logging conventions, toolkit filename).
        writeFileSync(fallbackFile, "", { flag: "wx" });
        fallbackState = "open";
      } catch (err) {
        fallbackState = "stderr";
        toStderr(`zipkit: log fallback file unavailable (${fallbackFile}: ${reason(err)}); logging to stderr\n`);
      }
    }
    if (fallbackState === "open") {
      try {
        appendFileSync(fallbackFile, line);
        return;
      } catch (err) {
        fallbackState = "stderr";
        toStderr(`zipkit: log fallback file write failed (${reason(err)}); logging to stderr\n`);
      }
    }
    toStderr(line);
  };

  const fallbackLine = ({ time, level, message, fields }: LogRecord): string =>
    `${JSON.stringify({ time, session, level, message, fields: JSON.parse(fields) as unknown })}\n`;

  const reportDatabaseFailure = (err: unknown): void => {
    if (databaseFailureReported) return;
    databaseFailureReported = true;
    toFallback(fallbackLine({
      time: new Date().toISOString(),
      level: "error",
      message: "records database unavailable",
      jobId: null,
      fields: serializeFields({ database: databaseFile, error: errorInfo(err) }),
    }));
  };

  const persist = (record: LogRecord): void => {
    const statement = openInsert();
    if (statement) {
      try {
        statement.run(record.time, session, record.level, record.message, record.jobId, record.fields);
        return;
      } catch (err) {
        reportDatabaseFailure(err);
      }
    } else {
      reportDatabaseFailure(databaseFailure);
    }
    toFallback(fallbackLine(record));
  };

  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (level === "debug" && process.env.ZIPKIT_DEBUG !== "1") return;
    const jobId = fields?.jobId;
    persist({
      time: new Date().toISOString(),
      level,
      message,
      jobId: typeof jobId === "string" ? jobId : null,
      fields: serializeFields(fields),
    });
  };

  return {
    database: databaseFile,
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
