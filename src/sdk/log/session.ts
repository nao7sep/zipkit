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
 * full, permissions), the sink degrades to `process.stderr` and the run
 * continues — the app never crashes because logging failed, and the failure is
 * surfaced as a one-line notice, never silently swallowed. The fallback uses
 * only what is already available (no new dependency).
 *
 * Writing to `process.stderr` is, strictly, the one place the SDK touches a
 * standard stream: it is the console fallback the logging convention mandates for
 * exactly this failure, and it fires only when the session file is unusable.
 */
export function openSessionLog(filePath: string): SessionLog {
  let degraded = false;

  const degrade = (reason: string): void => {
    if (degraded) return;
    degraded = true;
    try {
      process.stderr.write(`zipkit: session log unavailable (${reason}); logging to stderr\n`);
    } catch {
      /* even surfacing the failure is best-effort */
    }
  };

  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (err) {
    degrade(`${filePath}: ${messageOf(err)}`);
  }

  return {
    path: filePath,
    sink: (event) => {
      const line = `${JSON.stringify(event)}\n`;
      if (!degraded) {
        try {
          appendFileSync(filePath, line);
          return;
        } catch (err) {
          degrade(`write failed: ${messageOf(err)}`);
        }
      }
      try {
        process.stderr.write(line);
      } catch {
        /* the last-resort fallback is itself best-effort */
      }
    },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
