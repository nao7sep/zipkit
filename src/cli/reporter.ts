/**
 * The CLI's progress rendering. The log/progress *seam* — stamping, redaction,
 * debug gating, and fan-out — lives in the SDK logger; the durable per-session
 * log is owned by the SDK too. All the CLI adds is the live view: each event as
 * one bare JSONL line on stderr, the whole typed event with no prefix. It is not
 * gated on whether stderr is a TTY (scripts and agents watch stderr and want
 * every line); `--quiet` is the only suppressor, and it suppresses progress, not
 * errors.
 */

import type { LogSink } from "../sdk/log/logger.js";

/** The reporter-relevant slice of a verb's parsed options. */
export interface ReporterOptions {
  quiet?: boolean;
}

/** Live progress on stderr: each `LogEvent` as one bare JSONL line. */
function stderrProgress(): LogSink {
  return (event) => {
    process.stderr.write(`${JSON.stringify(event)}\n`);
  };
}

/**
 * The per-call `onProgress` hook for a verb: the stderr renderer, or `undefined`
 * under `--quiet` (the SDK is then silent on streams, its session log still
 * written). Returned to the verb as the call's `onProgress`.
 */
export function buildReporter(opts: ReporterOptions): LogSink | undefined {
  return opts.quiet ? undefined : stderrProgress();
}
