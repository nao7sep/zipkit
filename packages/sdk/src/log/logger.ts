/**
 * The one log/progress seam. A single `EmittedEvent` stream from the SDK core is
 * stamped, gated, and fanned out in one place; the `onEvent` hook
 * and the instance's per-session log are both just sinks. The logger is the edge
 * that turns a typed body into a convention {@link LogEvent}, in order:
 *
 * 1. **gate `debug`** — dropped unless the instance was built with
 *    `debug: true`, so the developer firehose reaches no sink (and never an
 *    end-user's session log);
 * 2. **stamp the envelope** — `time` (UTC ISO-8601 ms) and a `message` derived
 *    from the typed `event`;
 * 3. **fan out** — to every sink, each isolated, so one sink's failure never
 *    starves the others or aborts the run it is reporting on.
 *
 * With no sinks the logger does no work, so a pure SDK call with no `onEvent`
 * and no open session file is silent and free.
 */

import { observe } from "../internal/observe.js";
import { messageFor } from "./messages.js";
import type { LogEvent, LogEventBody, LogMeta } from "../types.js";

export type LogSink = (event: LogEvent) => void;

/** A typed event as emitted by the core, before the logger stamps the envelope. */
export type EmittedEvent = LogMeta & LogEventBody;

export interface Logger {
  emit(event: EmittedEvent): void;
}

/** `debug` events are developer-only: they reach the sinks only when `debug`. */
export function createLogger(sinks: LogSink[] = [], debug = false): Logger {
  return {
    emit(event) {
      if (sinks.length === 0) return;
      if (event.level === "debug" && !debug) return;
      const stamped: LogEvent = {
        time: new Date().toISOString(),
        message: messageFor(event),
        ...event,
      };
      // One sink's failure, thrown or a rejected promise, is not the run's,
      // nor the next sink's.
      for (const sink of sinks) observe(() => sink(stamped));
    },
  };
}
