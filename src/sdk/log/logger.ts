/**
 * The one log/progress seam. A single `EmittedEvent` stream from the SDK core is
 * stamped, gated, redacted, and fanned out in one place; the `onProgress` hook
 * and the instance's per-session log are both just sinks. The logger is the edge
 * that turns a typed body into a convention {@link LogEvent}, in order:
 *
 * 1. **gate `debug`** — dropped unless `ZIPKIT_DEBUG=1`, so the developer
 *    firehose reaches no sink (and never an end-user's session log);
 * 2. **stamp the envelope** — `time` (UTC ISO-8601 ms) and a `message` derived
 *    from the typed `event`;
 * 3. **redact** — the mandatory non-destructive backstop, run before the event
 *    reaches any sink, so a secret is scrubbed before it leaves the SDK;
 * 4. **fan out** — to every sink, each isolated, so one sink's failure never
 *    starves the others or aborts the run it is reporting on.
 *
 * With no sinks the logger does no work, so a pure SDK call with no `onProgress`
 * and no open session file is silent and free.
 */

import { messageFor } from "./messages.js";
import { redact } from "./redact.js";
import type { LogEvent, LogEventBody, LogMeta } from "../types.js";

export type LogSink = (event: LogEvent) => void;

/** A typed event as emitted by the core, before the logger stamps the envelope. */
export type EmittedEvent = LogMeta & LogEventBody;

export interface Logger {
  emit(event: EmittedEvent): void;
}

/** `debug` is developer-only: enabled only when `ZIPKIT_DEBUG=1`. Read per call
 *  so a developer (or a test) can toggle it without reloading the module. */
function debugEnabled(): boolean {
  return process.env.ZIPKIT_DEBUG === "1";
}

export function createLogger(sinks: LogSink[] = []): Logger {
  return {
    emit(event) {
      if (sinks.length === 0) return;
      if (event.level === "debug" && !debugEnabled()) return;
      const stamped: LogEvent = redact({
        time: new Date().toISOString(),
        message: messageFor(event),
        ...event,
      });
      for (const sink of sinks) {
        try {
          sink(stamped);
        } catch {
          /* best-effort: one sink's failure is not the run's, nor the next sink's */
        }
      }
    },
  };
}
