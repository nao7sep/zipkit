/**
 * The `--log` JSONL sink: one `LogEvent` per line, the same stream the SDK
 * callback and console renderer see. The file is opened eagerly so an
 * unwritable path fails fast as a clean `PolicyError` rather than surfacing
 * later as an uncaught stream `error` event; a late write error is captured so
 * the best-effort log can never crash the run.
 */

import { createWriteStream, openSync } from "node:fs";
import { PolicyError } from "../errors.js";
import type { LogSink } from "../log/logger.js";

export interface JsonlSink {
  sink: LogSink;
  close(): Promise<void>;
}

export function createJsonlSink(path: string): JsonlSink {
  let fd: number;
  try {
    fd = openSync(path, "w");
  } catch (err) {
    throw new PolicyError("log.open-failed", `cannot open log file: ${path}`, { cause: err });
  }

  const stream = createWriteStream(path, { fd });
  stream.on("error", () => {
    // The JSONL log is best-effort; a write failure must not crash the run.
  });

  return {
    sink: (event) => {
      stream.write(`${JSON.stringify(event)}\n`);
    },
    close: () =>
      new Promise<void>((resolve) => {
        stream.end(() => resolve());
      }),
  };
}
