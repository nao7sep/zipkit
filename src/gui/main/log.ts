/**
 * The app's own log — the lifecycle-and-orchestration record the main process
 * keeps, per the logging and data-lifecycle conventions: startup/shutdown, IPC
 * commands, queue transitions, and failures. The SDK's scan/plan/write/verify
 * events are recorded here too, under their job (`jobEvent`); the SDK instance
 * writes no log file of its own.
 *
 * Each line is a row in `records.sqlite3`, beside each job's SDK progress
 * events, written by the records thread (./records-worker); `debug` is gated by
 * `ZIPKIT_DEBUG=1`. The main process is the sole writer and the renderer
 * forwards its entries over IPC.
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { totalmem } from "node:os";
import { Worker } from "node:worker_threads";
import { fallbackLogDir, fileTimestamp, storageRoot } from "./storage.js";
import { JOB_EVENT_LIMIT, type JobAction, type JobEvent, type LogEvent } from "../shared/api.js";
import type {
  JobEventRow,
  LogRow,
  RecordsRead,
  RecordsReadResults,
  RecordsRequest,
  RecordsResponse,
  RecordsWorkerData,
  StoredJobEventRow,
} from "./records-worker.js";

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
  // A failure that crossed a process as plain data keeps its fields.
  if (!(err instanceof Error)) return typeof err === "object" && err !== null ? { ...err } : { value: String(err) };
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
  /** This launch's session, as every record of it carries. */
  readonly session: string;
  /** Record one SDK progress event under the job and run it belongs to,
   *  numbered in this launch; returns it as the window receives it. */
  jobEvent(jobId: string, event: LogEvent, action: JobAction, run: string): JobEvent;
  /** The job's newest recorded events, oldest first; none when the database
   *  cannot be read. */
  jobEvents(jobId: string): Promise<JobEvent[]>;
  /** Read the records database for the Records window, after every entry
   *  already given; rejects when it cannot be read within `waitMs`. */
  records<R extends RecordsRead>(read: R, waitMs?: number): Promise<RecordsReadResults[R["op"]]>;
  /** Called after each stored entry and once when the database becomes
   *  unavailable, so an open Records window can re-read and observe failure.
   *  Individual fallback entries do not notify. */
  onStored(listener: () => void): void;
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

/** How long a read waits for the records thread, which answers in the order
 *  it was asked, behind the writes already posted; above SQLite's own 5 s
 *  busy timeout, so a locked database fails the read before this bound. */
export const RECORDS_READ_WAIT_MS = 10_000;

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

type Write = { type: "log"; row: LogRow } | { type: "jobEvent"; row: JobEventRow };
type AdmittedWrite = { write: Write; line: string; bytes: number };

/** Diagnostics share a small machine-derived budget across the database and
 * fallback, so a stalled sink cannot accumulate the archive's event stream. */
export function diagnosticBudgetBytes(memory: number = totalmem()): number {
  return Math.max(128 * 1024, Math.min(8 * 1024 * 1024, Math.floor(memory / 4096)));
}

export const LOG_FALLBACK_WAIT_MS = 10_000;
const MAX_RECORDS_READS = 32;

/**
 * Open the app's records for this launch. Never throws: the records thread
 * writes each entry, and an entry it cannot take goes to this session's file
 * under `logs/`, then to stderr (logging conventions, When logging itself fails).
 */
export function createAppLog(
  databaseFile: string = defaultRecordsFile(),
  fallbackDir: string = fallbackLogDir(),
  now: Date = new Date(),
): SessionAppLog {
  const session = now.toISOString();
  // Seconds are enough (timestamp conventions): one ZipKit instance runs at a time, the file is
  // created exclusively, and SDK session logs in the same folder carry an id after their stamp.
  const fallbackFile = path.join(fallbackDir, `${fileTimestamp(now)}.log`);

  const budget = diagnosticBudgetBytes();
  let outstandingBytes = 0;
  let lost = 0;
  let lossReportScheduled = false;
  const reportLost = (): void => {
    if (lost === 0 || process.stderr.writableNeedDrain) return;
    const count = lost;
    lost = 0;
    try {
      process.stderr.write(`zipkit: ${count} diagnostic records lost because a logging sink was unavailable or full\n`);
    } catch {
      lost += count;
    }
  };
  const lose = (): void => {
    lost++;
    if (lossReportScheduled) return;
    lossReportScheduled = true;
    queueMicrotask(() => {
      lossReportScheduled = false;
      reportLost();
    });
  };
  const toStderr = (line: string): void => {
    reportLost();
    if (process.stderr.writableNeedDrain) {
      lose();
      return;
    }
    try {
      process.stderr.write(line);
    } catch {
      lose();
    }
  };

  const fallbackLine = (write: Write): string =>
    write.type === "log"
      ? JSON.stringify({
          time: write.row.time,
          session,
          level: write.row.level,
          message: write.row.message,
          fields: JSON.parse(write.row.fields) as unknown,
        })
      : JSON.stringify({
          time: write.row.time,
          session,
          jobId: write.row.jobId,
          seq: write.row.seq,
          action: write.row.action,
          run: write.row.run,
          event: JSON.parse(write.row.body) as unknown,
        });

  const admit = (write: Write): AdmittedWrite | null => {
    const line = `${fallbackLine(write)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > budget - outstandingBytes) {
      lose();
      return null;
    }
    outstandingBytes += bytes;
    return { write, line, bytes };
  };
  const release = (entry: AdmittedWrite): void => {
    outstandingBytes -= entry.bytes;
  };

  let fallbackState: "closed" | "open" | "stderr" = "closed";
  const fallbackQueue = new Set<AdmittedWrite>();
  // This is the actual physical operation, kept until settlement even after a
  // timeout. Once timed out, no further file operation starts this session.
  let fallbackFlight: Promise<void> | null = null;
  let fallbackDrained: Promise<void> = Promise.resolve();
  let resolveFallbackDrained: (() => void) | null = null;

  const drainToStderr = (): void => {
    for (const entry of fallbackQueue) {
      fallbackQueue.delete(entry);
      toStderr(entry.line);
      release(entry);
    }
  };
  const pumpFallback = (): void => {
    if (fallbackFlight !== null) return;
    if (fallbackState === "stderr") drainToStderr();
    const entry = fallbackQueue.values().next().value;
    if (!entry) {
      resolveFallbackDrained?.();
      resolveFallbackDrained = null;
      return;
    }
    fallbackQueue.delete(entry);
    let timedOut = false;
    let appendStarted = false;
    const operation = async (): Promise<void> => {
      try {
        if (fallbackState === "closed") {
          await mkdir(fallbackDir, { recursive: true });
          if (timedOut) return;
          // Never append into another launch's same-second file.
          await writeFile(fallbackFile, "", { flag: "wx" });
          if (timedOut) return;
          fallbackState = "open";
        }
        appendStarted = true;
        await appendFile(fallbackFile, entry.line);
      } catch (err) {
        if (timedOut) {
          toStderr(`zipkit: log fallback operation later failed (${reason(err)})\n`);
          return;
        }
        fallbackState = "stderr";
        toStderr(`zipkit: log fallback file unavailable (${fallbackFile}: ${reason(err)}); logging to stderr\n`);
        toStderr(entry.line);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      fallbackState = "stderr";
      toStderr(`zipkit: log fallback did not finish within ${LOG_FALLBACK_WAIT_MS} ms; its outcome is unknown; later records go to stderr\n`);
      if (!appendStarted) toStderr(entry.line);
      drainToStderr();
    }, LOG_FALLBACK_WAIT_MS);
    timer.unref();
    fallbackFlight = operation().finally(() => {
      clearTimeout(timer);
      release(entry);
      fallbackFlight = null;
      pumpFallback();
    });
  };
  const toFallback = (entry: AdmittedWrite): void => {
    if (fallbackState === "stderr") {
      toStderr(entry.line);
      release(entry);
      return;
    }
    if (resolveFallbackDrained === null) {
      fallbackDrained = new Promise<void>((resolve) => { resolveFallbackDrained = resolve; });
    }
    fallbackQueue.add(entry);
    pumpFallback();
  };

  let databaseFailureReported = false;
  const reportDatabaseFailure = (error: unknown): void => {
    if (databaseFailureReported) return;
    databaseFailureReported = true;
    const entry = admit({
      type: "log",
      row: {
        time: new Date().toISOString(),
        session,
        level: "error",
        message: "records database unavailable",
        jobId: null,
        fields: serializeFields({ database: databaseFile, error }),
      },
    });
    if (entry) toFallback(entry);
  };

  let worker: Worker | null = null;
  let workerFailed = false;
  let closing: Promise<void> | null = null;
  let nextId = 1;
  const pending = new Map<number, AdmittedWrite>();
  const reads = new Map<number, (response: RecordsResponse | Error) => void>();
  let storedListener: (() => void) | null = null;

  // Divert admitted writes once and promptly reject reads when the records
  // thread fails or does not close in time. Diagnostics remain best effort.
  const settleInFlight = (): void => {
    const writes = [...pending.values()];
    pending.clear();
    for (const write of writes) toFallback(write);
    const waiting = [...reads.values()];
    reads.clear();
    for (const settle of waiting) settle(new Error("the records thread stopped before answering"));
  };

  const failWorker = (err: unknown): void => {
    if (workerFailed) return;
    workerFailed = true;
    reportDatabaseFailure(errorInfo(err));
    settleInFlight();
    worker?.terminate().catch((err: unknown) =>
      toStderr(`zipkit: records thread did not stop (${reason(err)})\n`),
    );
    worker = null;
    storedListener?.();
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    const created = new Worker(workerUrl(), { workerData: { database: databaseFile } satisfies RecordsWorkerData });
    // The thread never keeps the process alive; `close` is what waits for it.
    created.unref();
    created.on("message", (response: RecordsResponse) => {
      if (response.type === "closed") return;
      const read = reads.get(response.id);
      if (read) {
        reads.delete(response.id);
        read(response);
        return;
      }
      const entry = pending.get(response.id);
      // A response may arrive after a timeout, diversion or close.
      if (!entry) return;
      if (response.type === "failed") {
        failWorker(response.error);
      } else if (response.type === "written") {
        pending.delete(response.id);
        release(entry);
        storedListener?.();
      }
    });
    created.on("error", failWorker);
    created.on("exit", (code) => {
      if (closing === null && worker === created) failWorker(new Error(`records thread exited with code ${code}`));
    });
    worker = created;
    return created;
  };

  const post = (request: RecordsRequest): void => {
    try {
      ensureWorker().postMessage(request);
    } catch (err) {
      failWorker(err);
    }
  };

  const persist = (write: Write): void => {
    const entry = admit(write);
    if (!entry) return;
    if (workerFailed || closing !== null) {
      toFallback(entry);
      return;
    }
    const id = nextId++;
    pending.set(id, entry);
    post({ ...write, id } as RecordsRequest);
  };

  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (level === "debug" && process.env.ZIPKIT_DEBUG !== "1") return;
    const jobId = fields?.jobId;
    persist({
      type: "log",
      row: {
        time: new Date().toISOString(),
        session,
        level,
        message,
        jobId: typeof jobId === "string" ? jobId : null,
        fields: serializeFields(fields),
      },
    });
  };

  let nextSeq = 1;
  const jobEvent = (jobId: string, event: LogEvent, action: JobAction, run: string): JobEvent => {
    const recorded: JobEvent = { jobId, session, seq: nextSeq++, action, run, event };
    persist({
      type: "jobEvent",
      row: {
        time: event.time,
        session,
        seq: recorded.seq,
        jobId,
        action,
        run,
        event: event.event,
        level: event.level,
        body: JSON.stringify(event),
      },
    });
    return recorded;
  };

  // Reads share the worker's ordered mailbox with writes. IDs are never
  // reused, so a timed-out read needs no retained tombstone.
  const read = (
    request: (id: number) => RecordsRequest,
    waitMs: number,
  ): Promise<RecordsResponse> => {
    if (workerFailed || closing !== null) return Promise.reject(new Error("the records database is closed"));
    if (reads.size >= MAX_RECORDS_READS) return Promise.reject(new Error("too many records reads are pending"));
    const id = nextId++;
    return new Promise<RecordsResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        reads.delete(id);
        reject(new Error(`the records database did not answer within ${waitMs} ms`));
      }, waitMs);
      reads.set(id, (response) => {
        clearTimeout(timer);
        if (response instanceof Error) reject(response);
        else if (response.type === "failed") reject(Object.assign(new Error("records read failed"), response.error));
        else resolve(response);
      });
      post(request(id));
    });
  };

  const jobEvents = async (jobId: string): Promise<JobEvent[]> => {
    if (workerFailed || closing !== null) return [];
    let rows: StoredJobEventRow[];
    try {
      const response = await read((id) => ({ type: "readJobEvents", id, jobId, limit: JOB_EVENT_LIMIT }), RECORDS_READ_WAIT_MS);
      rows = response.type === "read" ? response.rows : [];
    } catch (err) {
      write("warn", "job progress could not be read", { jobId, error: errorInfo(err) });
      return [];
    }
    return rows.map((row) => ({
      jobId,
      session: row.session,
      seq: row.seq,
      action: row.action as JobAction,
      run: row.run,
      event: JSON.parse(row.body) as LogEvent,
    }));
  };

  const records = async <R extends RecordsRead>(
    request: R,
    waitMs: number = RECORDS_READ_WAIT_MS,
  ): Promise<RecordsReadResults[R["op"]]> => {
    const response = await read((id) => ({ type: "readRecords", id, read: request }), waitMs);
    if (response.type !== "records") throw new Error(`unexpected records response: ${response.type}`);
    return response.value as RecordsReadResults[R["op"]];
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
      settleInFlight();
      reportLost();
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        fallbackDrained,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            toStderr(`zipkit: log fallback did not finish within ${waitMs} ms; its outcome is unknown\n`);
            resolve();
          }, waitMs);
        }),
      ]).finally(() => clearTimeout(timer));
    });
  };

  return {
    database: databaseFile,
    session,
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    jobEvent,
    jobEvents,
    records,
    onStored: (listener) => {
      storedListener = listener;
    },
    close,
  };
}
