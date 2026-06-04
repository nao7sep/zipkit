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

/** The underlying cause's message, when the error carries one — this is where
 *  the OS detail lives (e.g. "EACCES: permission denied, stat '/x'"). */
function causeMessage(err: unknown): string | undefined {
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string" && cause.length > 0) return cause;
  return undefined;
}

export function emitError(err: unknown): void {
  const code = err instanceof ZipKitError ? err.code : "unknown";
  const message = err instanceof Error ? err.message : String(err);
  const cause = causeMessage(err);
  // The stable code is a greppable handle for scripting; the cause carries the
  // OS-level reason that says *why* the operation failed.
  const suffix = cause !== undefined ? ` (${cause})` : "";
  process.stderr.write(`zipkit [${code}]: ${message}${suffix}\n`);
}
