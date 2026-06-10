/**
 * Derives the convention envelope's `message` — a short, stable, human-readable
 * line — from a typed {@link LogEventBody}. The logger calls this once per event
 * so every consumer (the per-session log, the `onProgress` hook, the CLI's
 * stderr progress) sees the same rendered string while the typed `event` fields
 * ride alongside untouched. The switch is exhaustive over the union, so adding a
 * new event variant is a compile error here until it is given a message.
 */

import type { LogEventBody } from "../types.js";

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
    case "scan.start":
      return `scanning ${body.inputs} input${s(body.inputs)}`;
    case "scan.dir":
      return `scanning ${body.path}`;
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
    case "extract.start":
      return `${body.write ? "extracting" : "verifying"} ${entries(body.entries)}`;
    case "entry.verified":
      return `verified ${body.path}`;
    case "extract.done":
      return `extract complete: ${body.written} written, ${body.skipped} skipped, ${body.crcFailed} CRC failure${s(body.crcFailed)}, ${body.shaMismatched} SHA mismatch${body.shaMismatched === 1 ? "" : "es"}`;
    case "fault":
      return body.cause !== undefined
        ? `${body.code}: ${body.detail}: ${body.cause}`
        : `${body.code}: ${body.detail}`;
  }
}
