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

/** A per-job lifecycle command for the right-pane command bar. */
export type JobCommand = "create" | "retry" | "cancel" | "verify" | "reveal" | "remove-archive";

/** The lifecycle commands available for a job in its current state. Pure, so the
 *  command bar reads one source and is unit-tested without a DOM. `needs-attention`
 *  intentionally offers none — the job is blocked until its options are fixed. */
export function jobCommands(job: Job): JobCommand[] {
  switch (job.state) {
    case "planning":
      return ["cancel"];
    case "needs-attention":
      return [];
    case "ready":
      return ["create"];
    case "running":
      return ["cancel"];
    case "failed":
      return ["retry"];
    case "done":
      return job.intent === "save"
        ? ["verify", "reveal", "remove-archive"]
        : ["verify", "reveal"];
  }
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

/** A local, ISO-ish timestamp for user-facing lines (timestamp-conventions:
 *  user-facing = local time, ISO-ish, English). The event's `time` is the SDK's
 *  internal UTC ISO form; this renders it in the viewer's local zone. Falls back
 *  to the raw value if it cannot be parsed. */
export function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** One activity-log line, with the time shown in local (not raw UTC) form. */
export function formatEventLine(event: LogEvent): string {
  return `${formatLocalTime(event.time)}  ${event.level}  ${event.message}`;
}

/** The target archive's file name (basename of the planned output path) — the
 *  identity a user reasons about. Empty string when there is no output yet. */
export function archiveName(output: string | undefined): string {
  if (!output) return "";
  const norm = output.replace(/\\/g, "/");
  return norm.split("/").pop() || norm;
}

/** A subtle row-background tint per job state, for at-a-glance distinction in the
 *  list. Kept low-contrast so the text stays readable over it. */
export function stateTint(state: Job["state"]): string {
  switch (state) {
    case "planning":
      return "transparent";
    case "needs-attention":
      return "rgba(255, 183, 77, 0.12)";
    case "ready":
      return "rgba(59, 130, 246, 0.16)";
    case "running":
      return "rgba(255, 238, 88, 0.12)";
    case "done":
      return "rgba(76, 175, 80, 0.14)";
    case "failed":
      return "rgba(239, 68, 68, 0.14)";
  }
}

/** The verify result one-liner. */
export function verifySummary(data: ExtractData): string {
  const s = data.summary;
  return `${s.total} entries, ${s.crcFailed} CRC failure(s), ${s.shaMismatched} SHA mismatch(es)`;
}
