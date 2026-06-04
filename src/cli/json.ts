/**
 * Machine and error output. `--json` emits the `Plan` (dry run) or
 * `WriteResult` (actual run) to stdout; the carrier holding absolute source
 * paths is non-enumerable, so `JSON.stringify` never serializes it. Errors go
 * to stderr so they never corrupt the JSON on stdout.
 */

import { ZipKitError } from "../errors.js";

export function emitJson(value: unknown): void {
  const indent = process.stdout.isTTY ? 2 : 0;
  process.stdout.write(`${JSON.stringify(value, null, indent)}\n`);
}

export function emitError(err: unknown): void {
  const payload =
    err instanceof ZipKitError
      ? { error: { type: err.errorType, code: err.code, message: err.message } }
      : {
          error: {
            type: "unknown",
            code: "unknown",
            message: err instanceof Error ? err.message : String(err),
          },
        };
  process.stderr.write(`zipkit: ${payload.error.message}\n`);
}
