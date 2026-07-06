/**
 * The per-session log file — the durable, always-on JSON-Lines record one
 * `ZipKit` instance keeps for its session. The convention: one file per session
 * under the app's own data dir (`~/.zipkit/logs/`), named by a UTC start
 * timestamp and nothing else — no app name, no word "log", no level.
 *
 * zipkit is built to fan out (an SDK invoked many times in parallel), so the
 * filename takes the millisecond `-fff` exception — `yyyymmdd-hhmmss-fff-utc.log`
 * — to keep the logs of independent runs that start in the same second distinct.
 * The `.log` extension holds JSON Lines (the convention's shape), not `.jsonl`.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { storageRoot } from "../storage.js";
import type { LogSink } from "./logger.js";

/** `<root>/logs` — the `logs/` subfolder under zipkit's storage root, where the
 *  root is `ZIPKIT_HOME` or `~/.zipkit` (resolved in one place by
 *  {@link storageRoot}). Created on the first write if missing. Overridable per
 *  instance via `logDir`, or for a whole process via the narrower
 *  `ZIPKIT_LOG_DIR` environment variable, which wins over this default. */
export function defaultLogDir(): string {
  return path.join(storageRoot(), "logs");
}

/**
 * `yyyymmdd-hhmmss-fff-utc` — a UTC session-start stamp with the millisecond
 * `-fff` part. Reads the OS clock (never an internal one). The body matches the
 * filename form in the timestamp convention; the `-fff` segment is its sanctioned
 * exception for tools designed to run concurrently.
 */
export function defaultSessionTimestamp(now: Date = new Date()): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const p3 = (n: number): string => String(n).padStart(3, "0");
  return (
    `${now.getUTCFullYear()}` +
    `${p2(now.getUTCMonth() + 1)}` +
    `${p2(now.getUTCDate())}` +
    `-${p2(now.getUTCHours())}` +
    `${p2(now.getUTCMinutes())}` +
    `${p2(now.getUTCSeconds())}` +
    `-${p3(now.getUTCMilliseconds())}` +
    `-utc`
  );
}

/** An open per-session log: its path plus a synchronous JSON-Lines sink. There
 *  is no descriptor to release — each line is appended in a single synchronous
 *  `appendFileSync`, so it is flushed before `emit` returns (the last lines
 *  before a crash reach disk) and nothing is held open between events. */
export interface SessionLog {
  /** The file this session is recorded to (returned to the caller as `result.log`). */
  readonly path: string;
  /** Append one event as a JSON line. */
  readonly sink: LogSink;
}

/**
 * Open the session log at `filePath`, creating its directory. Best-effort and
 * non-fatal: if the directory cannot be created, or a later append fails (disk
 * full, permissions), the sink degrades to a silent no-op and the run continues —
 * the SDK never crashes because logging failed, and it never falls back to a
 * standard stream (sdk-toolkit-conventions §4: an SDK prints nothing). The live
 * progress/event seam is a separate sink, independent of this file, so it keeps
 * carrying every event; the on-disk log is the one sink that goes quiet.
 */
export function openSessionLog(filePath: string): SessionLog {
  let degraded = false;

  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    degraded = true;
  }

  return {
    path: filePath,
    sink: (event) => {
      if (degraded) return;
      try {
        // not recorded: the SDK per-verb session log is append-mode and never uses the managed-text
        // atomic write path, so it never reaches the data-backup hook (excluded by construction —
        // data-backup conventions). (The SDK is also a separate layer with no dependency on the GUI's
        // backup store.)
        appendFileSync(filePath, `${JSON.stringify(event)}\n`);
      } catch {
        // The file became unusable mid-session. Degrade this sink to a no-op
        // rather than print: an SDK never writes to a standard stream. The live
        // event seam (a separate sink) still carries every event.
        degraded = true;
      }
    },
  };
}
