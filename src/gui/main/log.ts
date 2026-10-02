/**
 * The app's own log — the lifecycle-and-orchestration record the main process
 * keeps, per the logging and data-lifecycle conventions. It is distinct from
 * (and complementary to) the SDK instance's per-verb log file, which records
 * scan/plan/write/extract internals; each SDK result's `log` field names that
 * file. Here we record what the *app* does: startup/shutdown, IPC commands,
 * queue transitions, and failures.
 *
 * Each line is a row in `records.sqlite3`, written by the records thread
 * (./records-worker); `debug` is gated by `ZIPKIT_DEBUG=1`. The main process is
 * the sole writer and the renderer forwards its entries over IPC.
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { defaultLogDir, defaultSessionTimestamp } from "../../sdk/log/session.js";
import { storageRoot } from "../../sdk/storage.js";
import type { LogRow, RecordsRequest, RecordsResponse, RecordsWorkerData } from "./records-worker.js";

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
  /** Hand every record still in flight to the database, or to the fallback file
   *  when the database does not take it within `waitMs`. Later entries go
   *  straight to the fallback file. */
  close(waitMs?: number): Promise<void>;
}

/** `~/.zipkit/records.sqlite3` (or under `ZIPKIT_DATA_DIR`). */
export function defaultRecordsFile(): string {
  return path.join(storageRoot(), "records.sqlite3");
}

/** How long `close` waits for the database before the fallback file takes what
 *  it has not confirmed; inside the quit sequence's own bound. */
export const LOG_CLOSE_WAIT_MS = 5_000;

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

/** The bundled app runs electron-vite's `records-worker.js` beside this chunk;
 *  the tests run the source, which Node loads with its own type stripping. */
function workerUrl(): URL {
  const file = import.meta.url.endsWith(".ts") ? "./records-worker.ts" : "./records-worker.js";
  return new URL(file, import.meta.url);
}

/**
 * Open the app's log for this launch. Never throws: the records thread writes
 * each entry, and an entry it cannot take goes to this session's file under
 * `logs/`, then to stderr (logging conventions, When logging itself fails).
 */
export function createAppLog(
  databaseFile: string = defaultRecordsFile(),
  fallbackDir: string = process.env.ZIPKIT_LOG_DIR ?? defaultLogDir(),
  now: Date = new Date(),
): SessionAppLog {
  const session = now.toISOString();
  const fallbackFile = path.join(fallbackDir, `${defaultSessionTimestamp(now)}.log`);

  let fallbackState: "closed" | "open" | "stderr" = "closed";
  let fallbackTail: Promise<void> = Promise.resolve();

  const toStderr = (line: string): void => {
    try {
      process.stderr.write(line);
    } catch {
      /* the last resort is itself best-effort */
    }
  };

  const appendFallback = async (line: string): Promise<void> => {
    if (fallbackState === "closed") {
      try {
        await mkdir(fallbackDir, { recursive: true });
        // Exclusive create: a same-millisecond file another session already
        // holds is never appended into (logging conventions, toolkit filename).
        await writeFile(fallbackFile, "", { flag: "wx" });
        fallbackState = "open";
      } catch (err) {
        fallbackState = "stderr";
        toStderr(`zipkit: log fallback file unavailable (${fallbackFile}: ${reason(err)}); logging to stderr\n`);
      }
    }
    if (fallbackState === "open") {
      try {
        await appendFile(fallbackFile, line);
        return;
      } catch (err) {
        fallbackState = "stderr";
        toStderr(`zipkit: log fallback file write failed (${reason(err)}); logging to stderr\n`);
      }
    }
    toStderr(line);
  };

  // One append at a time, in the order the entries were made.
  const toFallback = (row: LogRow): void => {
    const line = `${JSON.stringify({
      time: row.time,
      session,
      level: row.level,
      message: row.message,
      fields: JSON.parse(row.fields) as unknown,
    })}\n`;
    fallbackTail = fallbackTail.then(() => appendFallback(line));
  };

  let databaseFailureReported = false;
  const reportDatabaseFailure = (error: unknown): void => {
    if (databaseFailureReported) return;
    databaseFailureReported = true;
    toFallback({
      time: new Date().toISOString(),
      session,
      level: "error",
      message: "records database unavailable",
      jobId: null,
      fields: serializeFields({ database: databaseFile, error }),
    });
  };

  let worker: Worker | null = null;
  let workerFailed = false;
  let closing: Promise<void> | null = null;
  let nextId = 1;
  const pending = new Map<number, LogRow>();

  // Whatever the records thread has not confirmed goes to the fallback file, so
  // a thread that fails or does not close in time loses none of it.
  const fallBackPending = (): void => {
    const rows = [...pending.values()];
    pending.clear();
    for (const row of rows) toFallback(row);
  };

  const failWorker = (err: unknown): void => {
    if (workerFailed) return;
    workerFailed = true;
    reportDatabaseFailure(errorInfo(err));
    fallBackPending();
    void worker?.terminate();
    worker = null;
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    const created = new Worker(workerUrl(), { workerData: { database: databaseFile } satisfies RecordsWorkerData });
    // The thread never keeps the process alive; `close` is what waits for it.
    created.unref();
    created.on("message", (response: RecordsResponse) => {
      if (response.type === "written") {
        pending.delete(response.id);
      } else if (response.type === "failed") {
        const row = pending.get(response.id);
        pending.delete(response.id);
        reportDatabaseFailure(response.error);
        if (row) toFallback(row);
      }
    });
    created.on("error", failWorker);
    created.on("exit", (code) => {
      if (closing === null && worker === created) failWorker(new Error(`records thread exited with code ${code}`));
    });
    worker = created;
    return created;
  };

  const persist = (row: LogRow): void => {
    if (workerFailed || closing !== null) {
      toFallback(row);
      return;
    }
    const id = nextId++;
    pending.set(id, row);
    try {
      ensureWorker().postMessage({ type: "log", id, row } satisfies RecordsRequest);
    } catch (err) {
      failWorker(err);
    }
  };

  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (level === "debug" && process.env.ZIPKIT_DEBUG !== "1") return;
    const jobId = fields?.jobId;
    persist({
      time: new Date().toISOString(),
      session,
      level,
      message,
      jobId: typeof jobId === "string" ? jobId : null,
      fields: serializeFields(fields),
    });
  };

  const close = (waitMs: number = LOG_CLOSE_WAIT_MS): Promise<void> => {
    closing ??= (async () => {
      const current = worker;
      if (!current || workerFailed) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        const settle = (): void => {
          clearTimeout(timer);
          resolve();
        };
        current.once("exit", settle);
        current.on("message", (response: RecordsResponse) => {
          if (response.type === "closed") settle();
        });
        try {
          current.postMessage({ type: "close" } satisfies RecordsRequest);
        } catch {
          settle();
        }
      });
      worker = null;
      // Not awaited: a thread blocked inside SQLite stops only once that call
      // returns, and a record it then completes is also in the fallback file.
      current.terminate().catch((err: unknown) =>
        toStderr(`zipkit: records thread did not stop (${reason(err)})\n`),
      );
    })();
    // Entries made after the first close go straight to the fallback file, so
    // every close waits for it.
    return closing.then(() => {
      fallBackPending();
      return fallbackTail;
    });
  };

  return {
    database: databaseFile,
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    close,
  };
}
