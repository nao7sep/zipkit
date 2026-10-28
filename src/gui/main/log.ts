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

import { createWriteStream, mkdirSync, openSync, type WriteStream } from "node:fs";
import path from "node:path";
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
   *  already given; rejects when it cannot be read. */
  records<R extends RecordsRead>(read: R): Promise<RecordsReadResults[R["op"]]>;
  /** Called after each stored entry and once when the database becomes
   *  unavailable, so an open Records window can re-read and observe failure.
   *  Individual fallback entries do not notify. */
  onStored(listener: () => void): void;
  /** Let the records thread write what it holds, then stop it; whatever it did
   *  not confirm goes to the fallback file. Later entries go straight to the
   *  fallback file. The quit's exit deadline bounds the wait. */
  close(): Promise<void>;
}

/** `~/.zipkit/records.sqlite3` (or under `ZIPKIT_DATA_DIR`). */
export function defaultRecordsFile(): string {
  return path.join(storageRoot(), "records.sqlite3");
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

/** The bundled app runs electron-vite's `records-worker.js` beside this chunk;
 *  the tests run the source, which Node loads with its own type stripping. */
function workerUrl(): URL {
  const file = import.meta.url.endsWith(".ts") ? "./records-worker.ts" : "./records-worker.js";
  return new URL(file, import.meta.url);
}

type Write = { type: "log"; row: LogRow } | { type: "jobEvent"; row: JobEventRow };

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

  // The fallback file, opened at its first entry (and again for an entry after
  // close); null while closed, and "stderr" once it cannot be written. The
  // stream keeps the entries in order.
  let fallback: WriteStream | "stderr" | null = null;
  let fallbackCreated = false;

  const toStderr = (line: string): void => {
    try {
      process.stderr.write(line);
    } catch {
      /* the last resort is itself best-effort */
    }
  };

  const openFallback = (): WriteStream | "stderr" => {
    let fd: number;
    try {
      mkdirSync(fallbackDir, { recursive: true });
      // Exclusive create: a same-second file another session already holds is
      // never appended into (logging conventions, toolkit filename).
      fd = openSync(fallbackFile, fallbackCreated ? "a" : "wx");
      fallbackCreated = true;
    } catch (err) {
      toStderr(`zipkit: log fallback file unavailable (${fallbackFile}: ${reason(err)}); logging to stderr\n`);
      return "stderr";
    }
    const stream = createWriteStream(fallbackFile, { fd });
    stream.on("error", (err) => {
      fallback = "stderr";
      toStderr(`zipkit: log fallback file write failed (${fallbackFile}: ${reason(err)}); logging to stderr\n`);
    });
    return stream;
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

  const toFallback = (write: Write): void => {
    const line = `${fallbackLine(write)}\n`;
    fallback ??= openFallback();
    if (fallback === "stderr") toStderr(line);
    else fallback.write(line);
  };

  // Where entries go: the records thread, until it fails or the log closes,
  // then the fallback file.
  let sink: "records" | "fallback" = "records";
  let worker: Worker | null = null;
  let closing: Promise<void> | null = null;
  let nextId = 1;
  // Each reply goes to its caller: a write waits for its confirmation, a read
  // for its rows.
  const pending = new Map<number, Write>();
  const reads = new Map<number, (response: RecordsResponse | Error) => void>();
  let storedListener: (() => void) | null = null;
  // Set while `close` waits for the thread, so a failure meanwhile ends the wait.
  let threadDone: (() => void) | null = null;

  // Whatever the records thread has not confirmed goes to the fallback file, and
  // a read it has not answered fails.
  const settleInFlight = (): void => {
    const writes = [...pending.values()];
    pending.clear();
    for (const write of writes) toFallback(write);
    const waiting = [...reads.values()];
    reads.clear();
    for (const settle of waiting) settle(new Error("the records thread stopped before answering"));
  };

  // The thread stops speaking for the records once it is let go of.
  const release = (): Worker | null => {
    const current = worker;
    worker = null;
    current?.removeAllListeners();
    return current;
  };

  const failWorker = (err: unknown): void => {
    if (sink === "fallback") return;
    sink = "fallback";
    toFallback({
      type: "log",
      row: {
        time: new Date().toISOString(),
        session,
        level: "error",
        message: "records database unavailable",
        jobId: null,
        fields: serializeFields({ database: databaseFile, error: errorInfo(err) }),
      },
    });
    settleInFlight();
    release()?.terminate().catch((err: unknown) =>
      toStderr(`zipkit: records thread did not stop (${reason(err)})\n`),
    );
    threadDone?.();
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
      if (response.type === "failed") {
        // The records thread refuses every later write once one fails; the
        // rest go to the fallback file at once.
        failWorker(response.error);
      } else if (response.type === "written") {
        pending.delete(response.id);
        storedListener?.();
      }
    });
    created.on("error", failWorker);
    created.on("exit", (code) => failWorker(new Error(`records thread exited with code ${code}`)));
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
    if (sink === "fallback") {
      toFallback(write);
      return;
    }
    const id = nextId++;
    pending.set(id, write);
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

  // Reads share the worker's ordered mailbox with writes, so a read answers
  // after every entry given before it.
  const read = (request: (id: number) => RecordsRequest): Promise<RecordsResponse> => {
    if (sink === "fallback") return Promise.reject(new Error("the records database is closed"));
    const id = nextId++;
    return new Promise<RecordsResponse>((resolve, reject) => {
      reads.set(id, (response) => {
        if (response instanceof Error) reject(response);
        else if (response.type === "failed") reject(Object.assign(new Error("records read failed"), response.error));
        else resolve(response);
      });
      post(request(id));
    });
  };

  const jobEvents = async (jobId: string): Promise<JobEvent[]> => {
    if (sink === "fallback") return [];
    let rows: StoredJobEventRow[];
    try {
      const response = await read((id) => ({ type: "readJobEvents", id, jobId, limit: JOB_EVENT_LIMIT }));
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

  const records = async <R extends RecordsRead>(request: R): Promise<RecordsReadResults[R["op"]]> => {
    const response = await read((id) => ({ type: "readRecords", id, read: request }));
    if (response.type !== "records") throw new Error(`unexpected records response: ${response.type}`);
    return response.value as RecordsReadResults[R["op"]];
  };

  const close = (): Promise<void> => {
    closing ??= (async () => {
      const current = worker;
      if (current && sink === "records") {
        // A thread asked to close ends on its own; that is no failure.
        current.removeAllListeners("exit");
        await new Promise<void>((resolve) => {
          threadDone = resolve;
          current.once("exit", () => resolve());
          current.on("message", (response: RecordsResponse) => {
            if (response.type === "closed") resolve();
          });
          try {
            current.postMessage({ type: "close" } satisfies RecordsRequest);
          } catch {
            resolve();
          }
        });
        threadDone = null;
      }
      sink = "fallback";
      release()?.terminate().catch((err: unknown) =>
        toStderr(`zipkit: records thread did not stop (${reason(err)})\n`),
      );
      settleInFlight();
    })();
    // Entries made after the first close go straight to the fallback file, so
    // every close waits for its stream to write them.
    return closing.then(async () => {
      const stream = fallback;
      if (stream === null || stream === "stderr") return;
      fallback = null;
      await new Promise<void>((resolve) => { stream.end(resolve); });
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
