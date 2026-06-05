/**
 * The one progress/log seam, shared by every verb. It composes the verb's
 * single `LogEvent` stream into the destinations a run wants — the optional
 * `--log` JSONL file, and (unless `--quiet`) live progress on stderr as human
 * phase lines or, under `--json`, prefixed JSONL. The composed `sink` is handed
 * to the SDK as the call's `onProgress` hook; `finalize` flushes the file.
 *
 * One seam for both `create` and `extract`: the same flags wire the same way, so
 * a caller sees identical progress and logging behavior across verbs.
 */

import type { LogSink } from "../log/logger.js";
import { createJsonlSink } from "./logSink.js";
import { createConsoleProgress, createJsonlProgress } from "./render.js";

/** The reporter-relevant slice of a verb's parsed options. */
export interface ReporterOptions {
  log?: string;
  quiet?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export interface Reporter {
  /** The composed event sink — passed to the SDK as `onProgress`. */
  sink: LogSink;
  /** Flush and close the `--log` file, if one was opened. */
  finalize: () => Promise<void>;
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

  // `--json` converts progress to prefixed JSONL on stderr; without it, human
  // phase lines. `--quiet` silences either.
  if (!opts.quiet) {
    sinks.push(
      opts.json ? createJsonlProgress(opts.verbose === true) : createConsoleProgress(opts.verbose === true),
    );
  }

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
