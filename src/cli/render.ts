/**
 * The human console renderer. Live progress aggregates into the
 * current phase and a running count on stderr — no per-entry spam (that lives
 * in the JSONL log) and no progress bar. The final plan or result summary is
 * rendered to stdout, findings severity-sorted.
 */

import type { LogSink } from "../log/logger.js";
import type { ExtractReport, Finding, Plan, Severity, WriteResult } from "../types.js";

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

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) return "";
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const lines = sorted.map((f) => `  [${f.severity}] ${f.rule}  ${f.path} — ${f.message}`);
  return `${lines.join("\n")}\n`;
}

export function renderPlan(plan: Plan): string {
  const s = plan.summary;
  const lines = [
    "zipkit plan",
    `  output:    ${plan.output}${plan.outputExists ? " (exists)" : ""}`,
    `  writable:  ${plan.writable ? "yes" : "no"}`,
    `  entries:   ${s.total} total — ${s.included} included, ${s.excluded} excluded, ${s.renamed} renamed`,
    `  zip64:     ${s.zip64 ? "yes" : "no"}`,
    `  findings:  ${s.warnings} warnings, ${s.errors} errors`,
  ];
  return `${lines.join("\n")}\n${renderFindings(plan.findings)}`;
}

export function renderResult(result: WriteResult): string {
  const lines = [
    `zipkit wrote ${result.output}`,
    `  entries:  ${result.entries}`,
    `  excluded: ${result.excluded}`,
    `  bytes:    ${result.bytes}`,
    `  zip64:    ${result.zip64 ? "yes" : "no"}`,
  ];
  return `${lines.join("\n")}\n${renderFindings(result.plan.findings)}`;
}

export function renderExtractReport(report: ExtractReport): string {
  const s = report.summary;
  const verb = report.wrote ? "extracted" : "validated";
  const lines = [
    `zipkit ${verb} ${report.archive}${report.dest ? ` → ${report.dest}` : ""}`,
    `  result:    ${report.ok ? "ok" : "FAILED"}`,
    `  entries:   ${s.total} total — ${s.written} written, ${s.skipped} not written`,
    `  integrity: ${s.crcFailed} CRC failures`,
  ];
  if (report.manifest) {
    lines.push(
      `  manifest:  ${report.manifest.name} (${report.manifest.source}) — ${s.shaMismatched} SHA mismatches, ${report.missing.length} missing, ${report.extra.length} extra`,
    );
  }
  return `${lines.join("\n")}\n${renderFindings(report.findings)}`;
}
