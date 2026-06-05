/**
 * The log event multiplexer. One `LogEvent` stream feeds every
 * consumer — the SDK callback, the CLI console renderer, the `--log` JSONL sink
 * — with no separate machinery. The logger is the edge that stamps each event
 * with its emission time; when no sink is attached it does no work.
 */

import type { LogEvent, LogEventBody, LogMeta } from "../types.js";

export type LogSink = (event: LogEvent) => void;

/** A typed event as emitted, before the logger stamps `ts`. */
export type EmittedEvent = LogMeta & LogEventBody;

export interface Logger {
  emit(event: EmittedEvent): void;
}

export function createLogger(sink?: LogSink): Logger {
  return {
    emit(event) {
      if (!sink) return;
      const stamped = { ts: new Date().toISOString(), ...event } as LogEvent;
      // Logging is best-effort observability: a consumer's sink that throws
      // must never abort the archive operation it is reporting on.
      try {
        sink(stamped);
      } catch {
        /* swallow — the sink's failure is not the run's failure */
      }
    },
  };
}
