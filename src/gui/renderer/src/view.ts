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
  ok: "#6fd08c",
  bad: "#ff6b7a",
  warn: "#ffb454",
  info: "#a3d977",
  busy: "#60a5fa",
  ready: "#f0b429",
  idle: "#8c9381",
} as const;

function baseName(p: string): string {
  const norm = p.replace(/\\/g, "/");
  return norm.split("/").pop() || norm;
}

/** A job's label: a single input shows its own name (with extension); multiple
 *  inputs show a quiet count of directories and files (each only when > 0) rather
 *  than a noisy file list. The counts need the on-disk classification (`entries`);
 *  before it resolves it falls back to a plain item count. */
export function label(job: Job): string {
  if (job.inputs.length === 0) return "(no input)";
  if (job.inputs.length === 1) return baseName(job.inputs[0]!);
  const entries = job.entries;
  if (!entries || entries.length === 0) return `${job.inputs.length} items`;
  const dirs = entries.filter((e) => e.kind === "directory").length;
  const files = entries.filter((e) => e.kind === "file").length;
  const parts: string[] = [];
  if (dirs > 0) parts.push(`${dirs} ${dirs === 1 ? "directory" : "directories"}`);
  if (files > 0) parts.push(`${files} ${files === 1 ? "file" : "files"}`);
  // All inputs missing/other: still say something honest.
  return parts.length > 0 ? parts.join(", ") : `${entries.length} items`;
}

/** Whether any of the job's originals still exist on disk, so trashing them is
 *  meaningful. Uses the classified `entries`; if they are not yet known, assume
 *  present (the engine re-checks before it trashes anything). */
export function originalsPresent(job: Job): boolean {
  if (!job.entries) return true;
  return job.entries.some((e) => e.kind === "directory" || e.kind === "file");
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

/** The human label for a job state — proper-cased for UI (the raw union is
 *  lower-kebab for code). Exhaustive over JobState so a new state can't slip out
 *  unlabelled. */
export function stateLabel(state: Job["state"]): string {
  switch (state) {
    case "planning":
      return "Planning";
    case "needs-attention":
      return "Needs attention";
    case "ready":
      return "Ready";
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
  }
}

/** The human label for a finding severity — proper-cased for UI. */
export function severityLabel(severity: Finding["severity"]): string {
  switch (severity) {
    case "error":
      return "Error";
    case "warning":
      return "Warning";
    case "info":
      return "Info";
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
export type JobCommand =
  | "create"
  | "retry"
  | "cancel"
  | "verify"
  | "reveal"
  | "trash-originals"
  | "remove-archive";

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
      if (job.intent !== "save") return ["verify", "reveal"];
      // A saved archive: verify/reveal it, optionally trash the originals (only
      // while they still exist), or remove the archive to edit and re-create.
      return originalsPresent(job)
        ? ["verify", "reveal", "trash-originals", "remove-archive"]
        : ["verify", "reveal", "remove-archive"];
  }
}

/** archive-and-trash verifies against the manifest before deleting, so it needs
 *  the manifest embedded; warn when the intent is set without it. */
export function manifestRequiredButMissing(intent: JobIntent, metadata: boolean): boolean {
  return intent === "archive-and-trash" && !metadata;
}

/** The short intent tag shown on a job row — only the noteworthy intent gets a
 *  tag; the plain "save" is the default and adds no signal, so it shows nothing. */
export function intentLabel(intent: JobIntent): string {
  return intent === "archive-and-trash" ? "→ Trash" : "";
}

/** The plan verdict headline: a factual, context-aware status, never a vague
 *  "safe" claim. Blocking findings stop the write; warnings are auto-fixed but
 *  worth noting; otherwise the job is simply ready to archive. */
export function verdictHeadline(plan: PlanData): string {
  const s = plan.summary;
  if (!plan.writable) return s.errors === 1 ? "1 blocking issue" : `${s.errors} blocking issues`;
  if (s.warnings > 0) return s.warnings === 1 ? "Ready · 1 warning" : `Ready · ${s.warnings} warnings`;
  return "Ready to archive";
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

/** The target archive's file name (basename of the planned output path): the
 *  identity a user reasons about. Empty string when there is no output yet. */
export function archiveName(output: string | undefined): string {
  if (!output) return "";
  const norm = output.replace(/\\/g, "/");
  return norm.split("/").pop() || norm;
}

/** The directory that contains a path (its parent), normalized for display.
 *  Empty string when the path is bare or at the filesystem root. Shown above the
 *  source → target line so the user sees where the archive lands. */
export function containingDir(p: string | undefined): string {
  if (!p) return "";
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i <= 0 ? "" : norm.slice(0, i);
}

/** A subtle row-background tint per job state, for at-a-glance distinction in the
 *  list. Kept low-contrast so the text stays readable over it. */
export function stateTint(state: Job["state"]): string {
  switch (state) {
    case "planning":
      return "transparent";
    case "needs-attention":
      return "rgba(255, 180, 84, 0.12)";
    case "ready":
      return "rgba(240, 180, 41, 0.14)";
    case "running":
      return "rgba(96, 165, 250, 0.12)";
    case "done":
      return "rgba(111, 208, 140, 0.14)";
    case "failed":
      return "rgba(255, 107, 122, 0.14)";
  }
}

/** The verify result one-liner. */
export function verifySummary(data: ExtractData): string {
  const s = data.summary;
  return `${s.total} entries, ${s.crcFailed} CRC failure(s), ${s.shaMismatched} SHA mismatch(es)`;
}
