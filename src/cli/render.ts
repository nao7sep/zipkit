/**
 * The console renderers. Progress is live on stderr: without `--json` as human
 * phase lines, under `--json` as prefixed minified JSONL — `--json` *converts*
 * progress rather than suppressing it. The final report is rendered to stdout
 * once, severity-sorting its findings and showing a failed verdict clearly;
 * `--json` renders the envelope instead.
 */

import type { LogSink } from "../log/logger.js";
import { emitProgressEvent } from "./json.js";
import type { CreateData, ExtractData, Finding, Severity } from "../types.js";

/** Human progress: aggregate phase lines on stderr, no per-entry spam (that
 *  lives in the JSONL log) unless `--verbose`. Each event's fields are typed by
 *  its `event` discriminant — no field is read by string key. */
export function createConsoleProgress(verbose: boolean): LogSink {
  return (event) => {
    switch (event.event) {
      case "scan.done":
        process.stderr.write(`scan: ${event.entries} entries\n`);
        break;
      case "plan.done":
        process.stderr.write(
          `plan: ${event.included} included, ${event.excluded} excluded, ${event.warnings} warnings, ${event.errors} errors\n`,
        );
        break;
      case "write.done":
        process.stderr.write(`write: ${event.bytes} bytes\n`);
        break;
      case "extract.done":
        process.stderr.write(
          `extract: ${event.total} entries, ${event.written} written, ${event.crcFailed} CRC failures\n`,
        );
        break;
      // Per-item progress for the long phases (scan walk, write, extract) plus
      // the plan's per-entry decisions — all path-only, shown under --verbose.
      case "scan.dir":
      case "entry.written":
      case "entry.verified":
      case "entry.excluded":
      case "entry.renamed":
        if (verbose) process.stderr.write(`${event.event}: ${event.path}\n`);
        break;
      case "entry.flagged":
        if (verbose) process.stderr.write(`entry.flagged: ${event.path} [${event.rule}]\n`);
        break;
      default:
        break;
    }
  };
}

/**
 * `--json` progress: convert the same log stream to prefixed minified JSONL on
 * stderr per the `ProgressEvent` shape. The terminal `.done` events always
 * frame; the per-entry events frame only under `--verbose`, mirroring the human
 * renderer's volume. Fields are read off the typed event, not a string bag.
 */
export function createJsonlProgress(verbose: boolean): LogSink {
  return (event) => {
    switch (event.event) {
      case "scan.done":
        emitProgressEvent({ event: "scan.done", entries: event.entries });
        break;
      case "plan.done":
        emitProgressEvent({ event: "plan.done", included: event.included, excluded: event.excluded });
        break;
      case "write.done":
        emitProgressEvent({ event: "write.done", bytes: event.bytes });
        break;
      case "extract.done":
        emitProgressEvent({ event: "extract.done", entries: event.total });
        break;
      case "scan.dir":
        if (verbose) emitProgressEvent({ event: "scan.dir", path: event.path });
        break;
      case "entry.written":
        if (verbose) emitProgressEvent({ event: "entry.written", path: event.path });
        break;
      case "entry.verified":
        if (verbose) emitProgressEvent({ event: "entry.verified", path: event.path });
        break;
      case "entry.excluded":
        if (verbose) emitProgressEvent({ event: "entry.excluded", path: event.path });
        break;
      case "entry.renamed":
        if (verbose) emitProgressEvent({ event: "entry.renamed", path: event.path });
        break;
      default:
        break;
    }
  };
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) return "";
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const lines = sorted.map((f) => `  [${f.severity}] ${f.rule}  ${f.path} — ${f.message}`);
  return `${lines.join("\n")}\n`;
}

/** Human render of the create payload — the dry-run plan or the write outcome.
 *  A failed verdict (not writable, or written:false) is shown clearly. */
export function renderCreateData(data: CreateData): string {
  if (data.mode === "plan") {
    const s = data.summary;
    const lines = [
      data.writable ? `zipkit plan ${data.output}` : `zipkit plan ${data.output} — NOT WRITABLE`,
      `  output:    ${data.output}`,
      `  writable:  ${data.writable ? "yes" : "no"}`,
      `  entries:   ${s.total} total — ${s.included} included, ${s.excluded} excluded, ${s.renamed} renamed`,
      `  zip64:     ${s.zip64 ? "yes" : "no"}`,
      `  findings:  ${s.warnings} warnings, ${s.errors} errors`,
    ];
    return `${lines.join("\n")}\n${renderFindings(data.findings)}`;
  }

  const s = data.summary;
  const header = data.written
    ? `zipkit wrote ${data.output}`
    : `zipkit create ${data.output} — FAILED`;
  const lines = [
    header,
    `  writable:  ${data.writable ? "yes" : "no"}`,
    `  written:   ${data.written ? "yes" : "no"}`,
    `  entries:   ${s.included} included, ${s.excluded} excluded`,
    `  bytes:     ${data.bytes ?? "—"}`,
    `  zip64:     ${data.zip64 ? "yes" : "no"}`,
  ];
  return `${lines.join("\n")}\n${renderFindings(data.findings)}`;
}

/** Human render of the extract payload. The verdict is `reportOk`. */
export function renderExtractData(data: ExtractData): string {
  const s = data.summary;
  const verb = data.wrote ? "extracted" : "validated";
  const lines = [
    `zipkit ${verb} ${data.archive}${data.dest ? ` → ${data.dest}` : ""}`,
    `  result:    ${data.reportOk ? "ok" : "FAILED"}`,
    `  entries:   ${s.total} total — ${s.written} written, ${s.skipped} not written`,
    `  integrity: ${s.crcFailed} CRC failures`,
  ];
  if (data.manifest) {
    lines.push(
      `  manifest:  ${data.manifest.name} — ${s.shaMismatched} SHA mismatches, ${data.missing.length} missing, ${data.extra.length} extra`,
    );
  }
  return `${lines.join("\n")}\n${renderFindings(data.findings)}`;
}
