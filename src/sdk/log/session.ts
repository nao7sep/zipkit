/**
 * The per-session log file — the durable, always-on JSON-Lines record one
 * `ZipKit` instance keeps for its session. The convention: one file per session
 * under the app's own data dir (`~/.zipkit/logs/`), named by a UTC start
 * timestamp and nothing else — no app name, no word "log", no level.
 *
 * zipkit is built to fan out (an SDK invoked many times in parallel), and
 * independent instances share one log folder, so the name carries a random id
 * after its seconds stamp — `yyyymmdd-hhmmss-utc-<id>.log` (timestamp
 * conventions, seconds + ID) — and the file is created exclusively, so two runs
 * never append into one file. The `.log` extension holds JSON Lines (the
 * convention's shape), not `.jsonl`.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { customAlphabet } from "nanoid";
import { storageRoot } from "../storage.js";
import type { LogSink } from "./logger.js";

/** `<root>/logs` — the `logs/` subfolder under ZipKit's storage root, where the
 *  root is `ZIPKIT_DATA_DIR` or `~/.zipkit` (resolved in one place by
 *  {@link storageRoot}). Created on the first write if missing. Overridable per
 *  instance via `logDir`, or for a whole process via the narrower
 *  `ZIPKIT_LOG_DIR` environment variable, which wins over this default. */
export function defaultLogDir(): string {
  return path.join(storageRoot(), "logs");
}

/** `yyyymmdd-hhmmss-utc`: a UTC filename stamp to the second, from the OS clock. */
export function fileTimestamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "").replace("T", "-") + "-utc";
}

/** Lowercase letters and digits only, as filenames take them; 12 of them make
 *  two runs that start in the same second practically never collide. */
const sessionId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

/** `yyyymmdd-hhmmss-utc-<id>.log`: one SDK instance's session log name. */
export function sessionLogName(now: Date = new Date(), id: string = sessionId()): string {
  return `${fileTimestamp(now)}-${id}.log`;
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
 * Open the session log at `filePath`, creating its directory and the file itself,
 * exclusively. Best-effort and non-fatal: if the directory or the file cannot be
 * created (a name another run already holds included), or a later append fails
 * (disk full, permissions), the sink degrades to a silent no-op and the run continues —
 * the SDK never crashes because logging failed, and it never falls back to a
 * standard stream (sdk-toolkit-conventions §4: an SDK prints nothing). The live
 * progress/event seam is a separate sink, independent of this file, so it keeps
 * carrying every event; the on-disk log is the one sink that goes quiet.
 */
export function openSessionLog(filePath: string): SessionLog {
  let degraded = false;

  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "", { flag: "wx" });
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
