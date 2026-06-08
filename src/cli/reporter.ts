/**
 * The one progress/log seam, shared by every verb. It composes the verb's
 * single `LogEvent` stream into the destinations a run wants — the optional
 * `--log` JSONL file, and (unless `--quiet`) live progress on stderr as bare
 * JSONL, one whole event object per line. The composed `sink` is handed to the
 * SDK as the call's `onProgress` hook; `finalize` flushes the file.
 *
 * One seam for both `create` and `extract`: the same flags wire the same way, so
 * a caller sees identical progress and logging behavior across verbs.
 */

import type { LogSink } from "../log/logger.js";
import { createJsonlSink } from "./logSink.js";

/** The reporter-relevant slice of a verb's parsed options. */
export interface ReporterOptions {
  log?: string;
  quiet?: boolean;
}

export interface Reporter {
  /** The composed event sink — passed to the SDK as `onProgress`. */
  sink: LogSink;
  /** Flush and close the `--log` file, if one was opened. */
  finalize: () => Promise<void>;
}

/**
 * Live progress on stderr: each `LogEvent` as one bare JSONL line — the whole
 * typed event, no prefix. Not gated on whether stderr is a TTY, because scripts
 * and agents watch stderr and want every line; `--quiet` is the only suppressor.
 */
function stderrProgress(): LogSink {
  return (event) => {
    process.stderr.write(`${JSON.stringify(event)}\n`);
  };
}

export function buildReporter(opts: ReporterOptions): Reporter {
  const sinks: LogSink[] = [];

  // `--log` writes the full event stream as JSONL regardless of `--quiet`, which
  // only governs the live console progress.
  let jsonl: ReturnType<typeof createJsonlSink> | undefined;
  if (opts.log !== undefined) {
    jsonl = createJsonlSink(opts.log);
    sinks.push(jsonl.sink);
  }

  if (!opts.quiet) sinks.push(stderrProgress());

  return {
    sink: (event) => {
      // Each sink is isolated: a failure in one (e.g. a broken console pipe)
      // must not starve the others (e.g. the JSONL audit log).
      for (const sink of sinks) {
        try {
          sink(event);
        } catch {
          /* best-effort: one sink's failure does not stop the rest */
        }
      }
    },
    finalize: async () => {
      if (jsonl) await jsonl.close();
    },
  };
}
