/**
 * What the window receives of a job's plan: the summary, the gate, the findings
 * and only the entries the report shows (volume-handling conventions, Item
 * count). An untouched file adds nothing to the report, so a large folder's plan
 * never crosses into the window whole. Pure, shared by main (which projects) and
 * the renderer (which reports).
 */

import type { Finding, PlanData, PlannedEntry, PlanSummary } from "./api.js";

export interface PlanReport {
  writable: boolean;
  summary: PlanSummary;
  /** Every finding of the run, those on entries included. */
  findings: Finding[];
  /** The entries with a change or a finding, in plan order. */
  entries: PlannedEntry[];
}

function lastSegment(p: string): string {
  return p.split("/").filter((s) => s !== "").pop() ?? "";
}

/** Whether an entry was renamed in its own right: its own name changed, or the
 *  SDK reported a rename on it (a parent segment with no folder entry of its
 *  own is reported on the entry). A name changed only because its folder was
 *  renamed is the folder's change, shown once on the folder's row. */
export function renamedItself(entry: PlannedEntry): boolean {
  if (entry.originalPath === entry.archivePath) return false;
  return (
    lastSegment(entry.originalPath) !== lastSegment(entry.archivePath) ||
    entry.findings.some((f) => f.fix?.kind === "rename")
  );
}

/** The entries the report can show a row for: one with a finding, an excluded
 *  one, or one renamed in its own right. */
function reported(entry: PlannedEntry): boolean {
  return entry.findings.length > 0 || entry.excluded || renamedItself(entry);
}

export function toPlanReport(plan: PlanData): PlanReport {
  return {
    writable: plan.writable,
    summary: plan.summary,
    findings: plan.findings,
    entries: plan.entries.filter(reported),
  };
}
