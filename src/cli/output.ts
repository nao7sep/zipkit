/**
 * The CLI output edge. stdout carries exactly one success document — the verb's
 * typed result object as JSON, emitted once at the end — and nothing else, so it
 * is cleanly redirectable to a file. It is pretty (indent 2) on a TTY and
 * compact when piped. Errors render on stderr only, never on stdout: a usage
 * fault (the caller's mistake) reads as a plain one-line message, any other
 * fault as a structured JSON error object. The exit code (see `errors.ts`) is
 * the machine signal; this is the readable rendering of the same fault.
 */

import { isUsageFault, ZipKitError } from "../errors.js";

/** Emit the one success document: the verb's typed result as JSON on stdout. */
export function emit(result: unknown): void {
  const indent = process.stdout.isTTY ? 2 : 0;
  process.stdout.write(`${JSON.stringify(result, null, indent)}\n`);
}

/**
 * Render a thrown fault on stderr, leaving stdout untouched. A usage fault is
 * the caller's to fix, so it reads as a plain message (commander's style); any
 * other fault is a structured `{ error: { type, code, message } }` object. The
 * underlying OS cause is folded into the single-line message.
 */
export function emitError(err: unknown): void {
  if (isUsageFault(err)) {
    process.stderr.write(`error: ${messageOf(err)}\n`);
    return;
  }
  const indent = process.stderr.isTTY ? 2 : 0;
  const error =
    err instanceof ZipKitError
      ? { type: err.errorType, code: err.code, message: messageOf(err) }
      : { type: "unknown", code: "unknown", message: messageOf(err) };
  process.stderr.write(`${JSON.stringify({ error }, null, indent)}\n`);
}

/** The error message with any underlying OS cause folded into one line. */
function messageOf(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
  return cause !== undefined ? `${base}: ${cause}` : base;
}
