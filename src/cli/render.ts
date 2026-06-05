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
 *  lives in the JSONL log) unless `--verbose`. */
export function createConsoleProgress(verbose: boolean): LogSink {
  return (event) => {
    const data = event.data ?? {};
    const field = (key: string): string => String(data[key] ?? "");
    switch (event.message) {
      case "scan.done":
        process.stderr.write(`scan: ${field("entries")} entries\n`);
        break;
      case "plan.done":
        process.stderr.write(
          `plan: ${field("included")} included, ${field("excluded")} excluded, ${field("warnings")} warnings, ${field("errors")} errors\n`,
        );
        break;
      case "write.done":
        process.stderr.write(`write: ${field("bytes")} bytes\n`);
        break;
      case "extract.done":
        process.stderr.write(
          `extract: ${field("total")} entries, ${field("written")} written, ${field("crcFailed")} CRC failures\n`,
        );
        break;
      default:
        if (
          verbose &&
          (event.message === "entry.excluded" ||
            event.message === "entry.renamed" ||
            event.message === "entry.flagged")
        ) {
          const rule = event.rule ? ` [${event.rule}]` : "";
          process.stderr.write(`${event.message}: ${event.path ?? ""}${rule}\n`);
        }
    }
  };
}

/** Numeric field from a log event's data bag, or undefined when absent. */
function numField(data: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = data?.[key];
  return typeof v === "number" ? v : undefined;
}

/**
 * `--json` progress: convert the same log stream to prefixed minified JSONL on
 * stderr per the `ProgressEvent` shape. The terminal `.done` events always
 * frame; the per-entry events frame only under `--verbose`, mirroring the human
 * renderer's volume.
 */
export function createJsonlProgress(verbose: boolean): LogSink {
  return (event) => {
    const data = event.data;
    switch (event.message) {
      case "scan.done":
        emitProgressEvent({ event: "scan.done", entries: numField(data, "entries") ?? 0 });
        break;
      case "plan.done":
        emitProgressEvent({
          event: "plan.done",
          included: numField(data, "included") ?? 0,
          excluded: numField(data, "excluded") ?? 0,
        });
        break;
      case "write.done":
        emitProgressEvent({ event: "write.done", bytes: numField(data, "bytes") ?? 0 });
        break;
      case "extract.done":
        emitProgressEvent({ event: "extract.done", entries: numField(data, "total") ?? 0 });
        break;
      default:
        if (!verbose) return;
        if (event.message === "entry.written" && event.path !== undefined) {
          emitProgressEvent({ event: "entry.written", path: event.path });
        } else if (event.message === "entry.excluded" && event.path !== undefined) {
          emitProgressEvent({ event: "entry.excluded", path: event.path });
        } else if (event.message === "entry.renamed" && event.path !== undefined) {
          emitProgressEvent({ event: "entry.renamed", path: event.path });
        }
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
