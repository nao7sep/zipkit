/**
 * Machine output framing. stdout carries exactly one report envelope, emitted
 * once at the end; `--json` renders it as the pretty (indent 2) envelope. There
 * is no TTY-based compact/pretty switch.
 *
 * stderr carries line-framed chunks. Under `--json` progress and faults convert
 * to prefixed minified JSONL (`zipkit[progress]:{…}` / `zipkit[error]:{…}`, no
 * space after the colon), each written as a single `write()` of the complete
 * line so two chunks' bytes never interleave.
 */

import { ZipKitError } from "../errors.js";
import { finding } from "../registry.js";
import type { Finding } from "../types.js";
import { SCHEMA_VERSION } from "../report.js";
import type { ErrorEvent, ProgressEvent, Report } from "../report.js";

/** A thrown operational fault, distilled into the pieces the CLI needs: a stable
 *  code, a single-line message with the OS cause folded in, and a subject path. */
export interface Fault {
  code: string;
  message: string;
  path: string;
}

/** The underlying cause's message — where the OS detail lives
 *  (e.g. "EACCES: permission denied, open '/x'"). */
function causeMessage(err: unknown): string | undefined {
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string" && cause.length > 0) return cause;
  return undefined;
}

/**
 * Distill a thrown value into a {@link Fault}: the stable `ZipKitError` code (or
 * `"unknown"`), and a single-line message with the OS cause folded in. `path` is
 * the subject the CLI knows — the output for create, the archive for extract.
 */
export function toFault(err: unknown, path: string): Fault {
  const code = err instanceof ZipKitError ? err.code : "unknown";
  const base = err instanceof Error ? err.message : String(err);
  const cause = causeMessage(err);
  const message = cause !== undefined ? `${base}: ${cause}` : base;
  return { code, message, path };
}

/** An operational fault as an error-tier finding (the SSOT fault carrier). */
export function faultFinding(fault: Fault): Finding {
  return finding(fault.code, fault.path, fault.message, { severity: "error" });
}

/** The canonical envelope serializer: pretty (indent 2) with one trailing
 *  newline. The internals carrier on a plan is non-enumerable, so
 *  `JSON.stringify` never serializes the absolute source paths it holds. */
export function serializeReport(report: Report<string, { findings: Finding[] }>): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Emit the one report envelope to stdout as the pretty JSON form. */
export function emitReport(report: Report<string, { findings: Finding[] }>): void {
  process.stdout.write(serializeReport(report));
}

/** Emit a progress chunk to stderr as one minified, prefixed JSONL line. */
export function emitProgressEvent(event: Omit<ProgressEvent, "schemaVersion">): void {
  const record: ProgressEvent = { schemaVersion: SCHEMA_VERSION, ...event };
  process.stderr.write(`zipkit[progress]:${JSON.stringify(record)}\n`);
}

/** Emit a fault chunk to stderr as one minified, prefixed JSONL line. The same
 *  fault also lands as a finding in the final stdout report. */
export function emitErrorEvent(event: Omit<ErrorEvent, "schemaVersion">): void {
  const record: ErrorEvent = { schemaVersion: SCHEMA_VERSION, ...event };
  process.stderr.write(`zipkit[error]:${JSON.stringify(record)}\n`);
}

/** A plain human fault line on stderr (no `--json`). The stable code is a
 *  greppable handle; the OS cause says why the operation failed. */
export function emitHumanError(code: string, message: string, cause?: string): void {
  const suffix = cause !== undefined ? ` (${cause})` : "";
  process.stderr.write(`zipkit [${code}]: ${message}${suffix}\n`);
}

/** Surface an operational fault live on stderr — the one path both verbs use:
 *  a prefixed `[error]` JSONL record under `--json`, else a human line. The same
 *  fault also lands as a finding in the final stdout report. */
export function emitFaultLive(json: boolean, fault: Fault): void {
  if (json) emitErrorEvent({ code: fault.code, message: fault.message, path: fault.path });
  else emitHumanError(fault.code, fault.message);
}
