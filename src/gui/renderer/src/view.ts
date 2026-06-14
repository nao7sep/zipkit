/**
 * Pure view derivations for the queue screen — the "what to show" logic kept
 * apart from the JSX "how to show it" in App.tsx, so it can be unit-tested
 * without a DOM. No React, no Electron, no Node: Job / Plan / Event data in,
 * strings / booleans / colors out. (This file is in the renderer project, so it
 * must stay Node-free — it carries no `node:*` import and no Node global.)
 */

import type { ExtractData, Finding, Job, JobIntent, LogEvent, PlanData } from "../../shared/api";

/** The dark-theme status palette, in one place so every status reads one map. */
export const COLOR = {
  ok: "#4caf50",
  bad: "#ff6b6b",
  warn: "#ffb74d",
  info: "#9ccc65",
  busy: "#ffee58",
  ready: "#42a5f5",
  idle: "#888",
} as const;

/** A short label for a job row: the first input's basename, "+N" for the rest. */
export function label(job: Job): string {
  const first = job.inputs[0] ?? "(no input)";
  const base = first.split("/").pop() || first;
  return job.inputs.length > 1 ? `${base} +${job.inputs.length - 1}` : base;
}

/** The status-badge color for each job state (exhaustive over JobState). */
export function stateColor(state: Job["state"]): string {
  switch (state) {
    case "planning":
      return COLOR.idle;
    case "needs-attention":
      return COLOR.warn;
    case "ready":
      return COLOR.ready;
    case "running":
      return COLOR.busy;
    case "done":
      return COLOR.ok;
    case "failed":
      return COLOR.bad;
  }
}

/** The color for a finding's severity tier (exhaustive over Severity). */
export function severityColor(severity: Finding["severity"]): string {
  switch (severity) {
    case "error":
      return COLOR.bad;
    case "warning":
      return COLOR.warn;
    case "info":
      return COLOR.info;
  }
}

/** A job's options/intent may be edited only before it runs and while not done. */
export function isEditable(state: Job["state"]): boolean {
  return state !== "running" && state !== "done";
}

/** Terminal states carry a final result, not an editable plan. */
export function isTerminal(state: Job["state"]): boolean {
  return state === "done" || state === "failed";
}

/** archive-and-trash verifies against the manifest before deleting, so it needs
 *  the manifest embedded; warn when the intent is set without it. */
export function manifestRequiredButMissing(intent: JobIntent, metadata: boolean): boolean {
  return intent === "archive-and-trash" && !metadata;
}

/** The short intent tag shown on a job row. */
export function intentLabel(intent: JobIntent): string {
  return intent === "archive-and-trash" ? "→ Trash" : "save";
}

/** The plan verdict headline. */
export function verdictHeadline(plan: PlanData): string {
  return plan.writable ? "Windows-safe ✓" : "Blocking issues";
}

/** The entries the plan dropped (excluded), for the "N dropped" detail. */
export function droppedEntries(plan: PlanData): PlanData["entries"] {
  return plan.entries.filter((e) => e.excluded);
}

/** One activity-log line. */
export function formatEventLine(event: LogEvent): string {
  return `${event.time}  ${event.level}  ${event.message}`;
}

/** The verify result one-liner. */
export function verifySummary(data: ExtractData): string {
  const s = data.summary;
  return `${s.total} entries, ${s.crcFailed} CRC failure(s), ${s.shaMismatched} SHA mismatch(es)`;
}
