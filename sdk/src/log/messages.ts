/**
 * Derives the convention envelope's `message` — a short, stable, human-readable
 * line — from a typed {@link LogEventBody}. The logger calls this once per
 * event so every `onEvent` hook sees the same rendered string while the typed
 * `event` fields ride alongside untouched. The switch is exhaustive over the union, so adding a
 * new event variant is a compile error here until it is given a message.
 */

import type { LogEventBody } from "../types.ts";

/** The trailing plural marker for a count: `1 → ""`, otherwise `"s"`. */
function s(n: number): string {
  return n === 1 ? "" : "s";
}

/** `"1 entry"` / `"3 entries"`. */
function entries(n: number): string {
  return `${n} ${n === 1 ? "entry" : "entries"}`;
}

export function messageFor(body: LogEventBody): string {
  switch (body.event) {
    case "session.start":
      return `zipkitsdk ${body.version} (concurrency ${body.concurrency}, chunk ${body.chunkSize} bytes, I/O timeout ${body.ioTimeoutMs} ms${body.debug ? ", debug" : ""})`;
    case "scan.start":
      return `scanning ${body.inputs} input${s(body.inputs)}`;
    case "scan.dir":
      return `scanning ${body.path}`;
    case "scan.symlink-unreadable":
      return `unreadable symlink target: ${body.path}`;
    case "scan.done":
      return `scan complete: ${entries(body.entries)}, ${body.prunedDirs} pruned dir${s(body.prunedDirs)}`;
    case "plan.done":
      return `plan complete: ${body.included} included, ${body.excluded} excluded, ${body.renamed} renamed, ${body.warnings} warning${s(body.warnings)}, ${body.errors} error${s(body.errors)}`;
    case "entry.excluded":
      return `excluded ${body.path}`;
    case "entry.renamed":
      return `renamed ${body.from} → ${body.path}`;
    case "entry.flagged":
      return `${body.severity}: ${body.rule} at ${body.path}`;
    case "write.start":
      return `writing ${entries(body.entries)}`;
    case "entry.written":
      return `wrote ${body.path}`;
    case "write.done":
      return `archive written: ${body.bytes} bytes${body.zip64 ? " (zip64)" : ""}`;
    case "verify.start":
      return `verifying ${entries(body.entries)}`;
    case "entry.verified":
      return `verified ${body.path}`;
    case "verify.done": {
      const problems = body.crc32Failed + body.unreadable + body.localMismatched + body.sha256Mismatched + body.manifestMismatched;
      return `verify complete: ${entries(body.total)}, ${problems === 0 ? "no problems" : `${problems} problem${s(problems)}`}${body.ok ? "" : " (not ok)"}`;
    }
    case "fault":
      // The line names what caused the failure too, read from the error itself.
      return body.error.cause !== undefined && body.error.cause.message !== body.error.message
        ? `${body.error.code}: ${body.error.message}: ${body.error.cause.message}`
        : `${body.error.code}: ${body.error.message}`;
  }
}
