/**
 * The app's own session log — the lifecycle-and-orchestration record the main
 * process keeps for one launch, per the application logging convention. It is
 * distinct from (and complementary to) the SDK instance's per-verb log, which
 * records scan/plan/write/extract internals; each SDK result's `log` field names
 * that file. Here we record what the *app* does: startup/shutdown, IPC commands,
 * queue transitions, and failures.
 *
 * One file per launch under `~/.zipkit/logs/`, JSON Lines, four levels with
 * `debug` developer-only (`ZIPKIT_DEBUG=1`), the mandatory non-destructive
 * redaction backstop. The generic, event-agnostic primitives (UTC session
 * timestamp, the data dir, the redactor) are reused from the SDK; the file sink
 * is owned here because the SDK's is typed to the SDK's event catalog. Per the
 * convention a sandboxed renderer never opens a file — it forwards structured
 * objects to main, the sole writer. The append is synchronous, so the last lines
 * before a crash reach disk; if the file is unusable it degrades to stderr and
 * the app keeps running.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultLogDir, defaultSessionTimestamp } from "../../sdk/log/session.js";
import { redact } from "../../sdk/log/redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface AppLog {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** A no-op logger: the default for the queue engine in tests and any context with
 *  no session file. */
export const nullLog: AppLog = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Serialize an error for logging — name, message, stack, and the cause chain, not
 * just `.message`. (An `Error`'s own properties are non-enumerable, so logging a
 * raw `Error` would stringify to `{}`.)
 */
export function errorInfo(err: unknown): LogFields {
  if (!(err instanceof Error)) return { value: String(err) };
  const info: LogFields = { name: err.name, message: err.message };
  if (err.stack) info.stack = err.stack;
  if (err.cause !== undefined) info.cause = errorInfo(err.cause);
  return info;
}

export interface SessionAppLog extends AppLog {
  /** The file this session is recorded to. */
  readonly path: string;
}

/**
 * Open the app's session log for this launch. Best-effort and non-fatal: if the
 * directory cannot be created or an append fails, it degrades to stderr and keeps
 * going — the app never crashes because logging failed, and the failure is
 * surfaced once, never silently swallowed.
 */
export function createAppLog(
  dir: string = process.env.ZIPKIT_LOG_DIR ?? defaultLogDir(),
  now: Date = new Date(),
): SessionAppLog {
  // `yyyymmdd-hhmmss-fff-utc.log` — the timestamp conventions' machine-paced form (a session log is
  // machine-paced regardless of process count), reusing the SDK's session-stamp helper rather than
  // duplicating the format here.
  const file = path.join(dir, `${defaultSessionTimestamp(now)}.log`);
  let degraded = false;

  const degrade = (reason: string): void => {
    if (degraded) return;
    degraded = true;
    try {
      process.stderr.write(`zipkit: app log unavailable (${reason}); logging to stderr\n`);
    } catch {
      /* even surfacing the failure is best-effort */
    }
  };

  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch (err) {
    degrade(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!degraded) {
    try {
      // Exclusive create ('wx'): the filename is millisecond-paced, so a
      // same-millisecond clash between two processes is only vanishingly
      // possible, not impossible. 'wx' fails with EEXIST rather than letting
      // the second process append into the first process's session file, which
      // would interleave two sessions into one log — the failure flows into the
      // same console fallback as any other open failure (tapebox's logger is the
      // fleet model for this open).
      writeFileSync(file, "", { flag: "wx" });
    } catch (err) {
      degrade(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const append = (event: LogFields): void => {
    let line: string;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch (err) {
      // A non-serializable field (a BigInt, a throwing toJSON) must not crash the
      // caller or lose the message: fall back to the envelope alone, which
      // `write` guarantees are three plain strings, so this can never itself
      // throw (the SDK's own session sink, src/sdk/log/session.ts, is the model
      // for keeping serialization inside this same guard as the write).
      const fallback: LogFields = {
        time: event.time,
        level: event.level,
        message: event.message,
        error: `serialization failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      line = `${JSON.stringify(fallback)}\n`;
    }

    if (!degraded) {
      try {
        // not recorded: the session log is append-mode and never uses the managed-text atomic
        // temp-then-rename path, so it never reaches the data-backup hook (excluded by construction —
        // data-backup conventions).
        appendFileSync(file, line);
        return;
      } catch (err) {
        degrade(`write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      process.stderr.write(line);
    } catch {
      /* the last-resort fallback is itself best-effort */
    }
  };

  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (level === "debug" && process.env.ZIPKIT_DEBUG !== "1") return;
    // Caller fields are spread FIRST so the envelope keys always win: a field
    // accidentally (or maliciously) named `time`/`level`/`message` can never
    // overwrite the line's own envelope (tapebox's formatter is the fleet model).
    const event = redact({ ...fields, time: new Date().toISOString(), level, message });
    append(event);
  };

  return {
    path: file,
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
