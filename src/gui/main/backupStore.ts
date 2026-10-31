/**
 * The write-through data-backup store (data-backup conventions). It owns one SQLite file,
 * `backups.sqlite3`, directly under zipkit's storage root (`ZIPKIT_DATA_DIR` or `~/.zipkit`, resolved in
 * one place by the SDK's {@link storageRoot} — never a hardcoded path). The one protected file,
 * `config.json`, records the exact bytes it just wrote here, strictly AFTER its atomic rename lands,
 * keeping one row per launch. There is no startup scan, no periodic pass, no restore path.
 *
 * The database is written by the backups thread (./backups-worker), so a slow or locked store never
 * holds the main process; this module posts each record and hears back how it went.
 *
 * Two absolute musts drive every line below (they are not best-effort aspirations):
 *
 *  - It never breaks a save and never crashes the app. The save has already succeeded — the file is on
 *    disk before {@link record} is called — so any failure here (the DB is locked, the disk is full, an
 *    insert throws, the thread dies) is logged at `warn` and swallowed. An individual record failure may
 *    be retried on the next save of that file. A failed store open or worker failure disables backups
 *    for the rest of this session and is logged once.
 *  - It logs only failures. A successful record logs NOTHING; a line per save would flood the log.
 */

import path from "node:path";
import { Worker } from "node:worker_threads";
import { storageRoot } from "./storage.js";
import { log } from "./runtime.js";
import { errorInfo } from "./log.js";
import { APP_PACKAGE, APP_VERSION } from "../shared/identity.js";
import type { BackupsRequest, BackupsResponse, BackupsWorkerData } from "./backups-worker.js";

/** The store file under the resolved storage root. Computed when the thread starts (not frozen into a
 *  module constant at import time) so `ZIPKIT_DATA_DIR` is read after the environment is set, per the
 *  storage-path convention's caution against import-time resolution. */
function storeFile(): string {
  return path.join(storageRoot(), "backups.sqlite3");
}

/** The bundled app runs electron-vite's `backups-worker.js` beside this chunk; the tests run the
 *  source, which Node loads with its own type stripping. */
function workerUrl(): URL {
  const file = import.meta.url.endsWith(".ts") ? "./backups-worker.ts" : "./backups-worker.js";
  return new URL(file, import.meta.url);
}

/** The session's thread and the records it has not answered yet, by request id. `disabled` means
 *  recording is off for this session because the store could not be opened or the thread failed — a
 *  single warn was already logged; every later {@link record} becomes a no-op rather than retrying (and
 *  re-logging). */
let worker: Worker | null = null;
let file = "";
let disabled = false;
let closing: Promise<void> | null = null;
let nextId = 1;
const pending = new Map<number, { path: string; settle: () => void }>();

function settlePending(): void {
  const waiting = [...pending.values()];
  pending.clear();
  for (const { settle } of waiting) settle();
}

const THREAD_FAILED = "backup store: the recording thread failed; recording disabled for this session";

/** Let go of the thread: it no longer speaks for the store. */
function release(): Worker | null {
  const current = worker;
  worker = null;
  current?.removeAllListeners();
  return current;
}

function disable(message: string, error: unknown): void {
  if (disabled) return;
  disabled = true;
  log.warn(message, { file, error });
  settlePending();
  void release()?.terminate();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  file = storeFile();
  const created = new Worker(workerUrl(), { workerData: { database: file, session: log.session, writer: { name: APP_PACKAGE, version: APP_VERSION } } satisfies BackupsWorkerData });
  // The thread never keeps the process alive; closeBackupStore is what waits for it.
  created.unref();
  created.on("message", (response: BackupsResponse) => {
    if (response.type === "closed") return;
    const entry = pending.get(response.id);
    pending.delete(response.id);
    if (response.type === "failed") {
      if (response.stage === "open") {
        disable("backup store: could not open; recording disabled for this session", response.error);
      } else {
        log.warn("backup store: failed to record a managed write", { file: entry?.path, error: response.error });
      }
    }
    entry?.settle();
  });
  created.on("error", (err) => disable(THREAD_FAILED, errorInfo(err)));
  created.on("exit", (code) => disable(THREAD_FAILED, { message: `exited with code ${code}` }));
  worker = created;
  return created;
}

/**
 * Record one managed-text write: `absolutePath` is the FULL absolute path of the file as written;
 * `bytes` is the exact raw bytes just written (the caller already holds them — never re-read the file).
 * The thread keeps one row per path for this launch and writes nothing for content equal to the
 * path's latest row.
 *
 * Best-effort and silent on success. It never throws and never breaks the save; the returned promise
 * never rejects and settles once the thread has answered (or recording has stopped), so a caller that
 * must see the row can wait for it.
 */
export function record(absolutePath: string, bytes: Buffer): Promise<void> {
  if (disabled) return Promise.resolve(); // disabled for the session (already warned once)
  if (closing !== null) {
    log.warn("backup store: closing; a managed write was not recorded", { file: absolutePath });
    return Promise.resolve();
  }
  const id = nextId++;
  const request: BackupsRequest = {
    type: "record",
    id,
    // Copied, not transferred: a small Buffer is a view into Node's shared pool.
    record: { path: absolutePath, content: bytes, writtenAt: new Date().toISOString() },
  };
  return new Promise<void>((resolve) => {
    pending.set(id, { path: absolutePath, settle: resolve });
    try {
      ensureWorker().postMessage(request);
    } catch (err) {
      disable(THREAD_FAILED, errorInfo(err));
    }
  });
}

/**
 * Stop the thread, first letting it finish the records it holds when `drain`; the quit's exit
 * deadline bounds the wait. Resets the store so the next {@link record} re-opens against the current
 * `ZIPKIT_DATA_DIR` (tests use throwaway roots).
 */
export function closeBackupStore(drain = true): Promise<void> {
  // The reset runs in `finally`, after `closing` is assigned, so a close with no thread still clears it.
  closing ??= (drain ? stopThread() : abandonThread()).finally(() => {
    settlePending();
    worker = null;
    disabled = false;
    closing = null;
  });
  return closing;
}

/** Ends the thread without its pending records; resolves once it has stopped, which a thread
 *  blocked inside SQLite does only when that call returns. */
async function abandonThread(): Promise<void> {
  await release()?.terminate();
}

async function stopThread(): Promise<void> {
  const current = worker;
  if (!current) return;
  // A thread asked to close ends on its own; that is no failure.
  current.removeAllListeners("exit");
  await new Promise<void>((resolve) => {
    current.once("exit", () => resolve());
    current.on("message", (response: BackupsResponse) => {
      if (response.type === "closed") resolve();
    });
    try {
      current.postMessage({ type: "close" } satisfies BackupsRequest);
    } catch {
      resolve();
    }
  });
  // Not awaited: a thread blocked inside SQLite stops only once that call returns.
  release()?.terminate().catch(() => {});
}
