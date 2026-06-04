/**
 * The log event multiplexer (§10.11). One `LogEvent` stream feeds every
 * consumer — the SDK callback, the CLI console renderer, the `--log` JSONL sink
 * — with no separate machinery. The logger is the edge that stamps each event
 * with its emission time; when no sink is attached it does no work.
 */

import type { LogEvent } from "../types.js";

export type LogSink = (event: LogEvent) => void;

export interface LogFields {
  rule?: string;
  path?: string;
  data?: Record<string, unknown>;
}

export interface Logger {
  emit(
    stage: LogEvent["stage"],
    level: LogEvent["level"],
    message: string,
    fields?: LogFields,
  ): void;
}

export function createLogger(sink?: LogSink): Logger {
  return {
    emit(stage, level, message, fields) {
      if (!sink) return;
      const event: LogEvent = {
        ts: new Date().toISOString(),
        stage,
        level,
        message,
      };
      if (fields?.rule !== undefined) event.rule = fields.rule;
      if (fields?.path !== undefined) event.path = fields.path;
      if (fields?.data !== undefined) event.data = fields.data;
      sink(event);
    },
  };
}
