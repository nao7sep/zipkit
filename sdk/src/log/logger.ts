/**
 * The one log seam. A call's typed events are stamped and gated in one place
 * and handed to its `onEvent` hook. The logger is the edge that turns a typed
 * body into a convention {@link LogEvent}, in order:
 *
 * 1. **gate `debug`** — dropped unless the instance was built with
 *    `debug: true`, so the developer firehose reaches no hook;
 * 2. **stamp the envelope** — `time` (UTC ISO-8601 ms) and a `message` derived
 *    from the typed `event`;
 * 3. **deliver** — to the hook, isolated, so its failure never aborts the run
 *    it is reporting on.
 *
 * Without a hook the logger does no work, so an SDK call with no `onEvent` is
 * silent and free.
 */

import { messageFor } from "./messages.ts";
import type { LogEvent, LogEventBody, LogMeta } from "../types.ts";

export type LogSink = (event: LogEvent) => void;

/** A typed event as emitted by the core, before the logger stamps the envelope. */
export type EmittedEvent = LogMeta & LogEventBody;

export interface Logger {
  emit(event: EmittedEvent): void;
}

/** `debug` events are developer-only: they reach the hook only when `debug`. */
export function createLogger(sink?: LogSink, debug = false): Logger {
  return {
    emit(event) {
      if (sink === undefined) return;
      if (event.level === "debug" && !debug) return;
      const stamped: LogEvent = {
        time: new Date().toISOString(),
        message: messageFor(event),
        ...event,
      };
      try {
        sink(stamped);
      } catch {
        /* best-effort: the hook's failure is not the run's */
      }
    },
  };
}
