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

import { appendFileSync, mkdirSync } from "node:fs";
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

  const append = (line: string): void => {
    if (!degraded) {
      try {
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
    const event = redact({ time: new Date().toISOString(), level, message, ...fields });
    append(`${JSON.stringify(event)}\n`);
  };

  return {
    path: file,
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
