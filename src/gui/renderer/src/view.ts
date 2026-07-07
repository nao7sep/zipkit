/**
 * Pure view derivations for the queue screen — the "what to show" logic kept
 * apart from the JSX "how to show it" in App.tsx, so it can be unit-tested
 * without a DOM. No React, no Electron, no Node: Job / Plan / Event data in,
 * strings / booleans / colors out. (This file is in the renderer project, so it
 * must stay Node-free — it carries no `node:*` import and no Node global.)
 */

import type { ExtractData, Finding, InputEntry, Job, JobIntent, LogEvent, PathKind, PlanData, Severity } from "../../shared/api";
import type { GuiOptions } from "../../shared/spec";

/** The dark-theme status palette, in one place so every status reads one map. */
export const COLOR = {
  ok: "#6fd08c",
  bad: "#ff6b7a",
  warn: "#ffb454",
  info: "#a3d977",
  busy: "#60a5fa",
  // Waiting its turn: a muted, desaturated blue — kin to `busy` (it's about to
  // run) but calmer, so "queued" reads as pending rather than active. Picked to
  // sit in the golden-workbench palette; safe to retone alongside the rest.
  queued: "#8aa0c0",
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

/** Display order for the input list: directories first, then files, then anything
 *  else (other / missing) last; within each group, full paths sorted alphabetically
 *  (case-insensitive). Pure, so the order is testable without a DOM. */
const KIND_RANK: Record<PathKind, number> = { directory: 0, file: 1, other: 2, nonexistent: 3 };
export function orderedEntries(entries: InputEntry[]): InputEntry[] {
  return [...entries].sort((a, b) => {
    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    return byKind !== 0 ? byKind : a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
  });
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
    case "queued":
      return COLOR.queued;
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
    case "queued":
      return "Queued";
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

/** A job's options/intent may be edited only before it runs and while not done. A
 *  `queued` job is committed to run (waiting its turn), so it is locked too —
 *  cancelling it returns it to an editable `ready`/`needs-attention` state. */
export function isEditable(state: Job["state"]): boolean {
  return state !== "running" && state !== "done" && state !== "queued";
}

/** Terminal states carry a final result, not an editable plan. */
export function isTerminal(state: Job["state"]): boolean {
  return state === "done" || state === "failed";
}

/** States a job can be cancelled out of: in-flight work (`planning`/`running`) or
 *  waiting its turn (`queued`). Cancelling re-plans the job back to an editable
 *  state. Drives the listbox Cancel affordance (button + Escape). */
export function isCancelable(state: Job["state"]): boolean {
  return state === "planning" || state === "queued" || state === "running";
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
    case "queued":
      // Waiting its turn: the only act is to pull it back out of the queue.
      return ["cancel"];
    case "running":
      return ["cancel"];
    case "failed":
      // If the archive was written but a later step failed (an archive-and-trash
      // whose verify/Trash failed, so the .zip exists and the originals are kept),
      // let the user inspect or clean up that file — not just retry. A plain write
      // failure leaves no output, so it offers only "Try again".
      return job.output ? ["retry", "reveal", "remove-archive"] : ["retry"];
    case "done":
      if (job.intent !== "save") return ["verify", "reveal"];
      // A saved archive: verify/reveal it, remove the archive to edit and
      // re-create, or (only while they still exist) trash the originals. The most
      // destructive command (trash-originals) is ordered last so the command bar
      // can seat it at the far-right end, away from the everyday buttons.
      return originalsPresent(job)
        ? ["verify", "reveal", "remove-archive", "trash-originals"]
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

/** One line of the report — a severity level, a human sentence, and the path it
 *  concerns (omitted for the summary line). The renderer colors by `level`. */
export interface ReportLine {
  level: Severity;
  text: string;
  path?: string;
}

function pluralItems(n: number): string {
  return `${n} item${n === 1 ? "" : "s"}`;
}

/** Plain, actionable GUI guidance for the SDK error codes a user can hit while
 *  setting up a job, keyed on the stable `code` (never the message text). Codes
 *  without an entry fall back to the SDK's own message — accurate, if terser. */
const ERROR_GUIDANCE: Record<string, string> = {
  "output.ambiguous":
    "These inputs are in different folders, so ZipKit can't choose a location on its own. Set a file name (the output directory defaults to the first input's folder) and they'll be archived together.",
  "scan.input-missing": "An input no longer exists on disk. Remove it from the list or restore it, then try again.",
  "scan.stat-failed": "An input couldn't be read — it may be locked or permission-protected. Check it, then try again.",
  "scan.walk-failed": "A folder couldn't be fully read (a permission or I/O problem). Check it, then try again.",
};

/** The report's headline sentence: context-aware, factual, and never the vague
 *  "Windows-safe" claim. Speaks to the job's actual state — failed, done, blocked,
 *  or ready (with what the archive will carry / what was auto-handled). */
export function reportSummary(job: Job, plan: PlanData | null): ReportLine | null {
  if (job.state === "failed") {
    return { level: "error", text: job.message ?? "The archive could not be created." };
  }
  // A blocked job must ALWAYS explain itself, even when the plan threw and left no
  // structured data (plan === null) — the captured message is the only explanation
  // the user gets, so never swallow it. Prefer friendly guidance keyed on the SDK
  // error code; fall back to the structured count, then the raw message.
  if (job.state === "needs-attention") {
    const guidance = job.errorCode ? ERROR_GUIDANCE[job.errorCode] : undefined;
    if (guidance) return { level: "error", text: guidance };
    if (plan) {
      const n = plan.summary.errors;
      return {
        level: "error",
        text: `${n} blocking issue${n === 1 ? "" : "s"} must be resolved before this can be archived.`,
      };
    }
    return { level: "error", text: job.message ?? "This job can't be archived yet." };
  }
  if (!plan) return null; // planning — nothing to report yet
  const s = plan.summary;
  if (job.state === "done") {
    return { level: "info", text: `Archived ${pluralItems(s.included)}.` };
  }
  const extras: string[] = [];
  if (s.renamed > 0) extras.push(`${s.renamed} renamed for portability`);
  if (s.excluded > 0) extras.push(`${s.excluded} excluded`);
  if (s.warnings > 0) extras.push(`${s.warnings} warning${s.warnings === 1 ? "" : "s"}`);
  const tail = extras.length > 0 ? ` (${extras.join(", ")})` : "";
  return {
    level: s.warnings > 0 ? "warning" : "info",
    text: `${pluralItems(s.included)} ready to archive${tail}.`,
  };
}

/** GUI-side advisories about the inputs themselves — guidance the SDK doesn't
 *  emit (it isn't an archive fault, just advice). Currently: a lone `.zip` input
 *  gains little from re-compression and would only nest. Shown in the Report so
 *  the user sees it before creating. */
export function jobAdvisories(job: Job): ReportLine[] {
  const lines: ReportLine[] = [];
  const onlyInput = job.inputs.length === 1 ? job.inputs[0] : undefined;
  const isFile = job.entries?.[0]?.kind === "file";
  if (onlyInput && isFile && /\.zip$/i.test(onlyInput)) {
    lines.push({
      level: "warning",
      text: "This input is already a .zip — re-compressing it saves little and just nests a zip inside a zip. Archive its contents instead, or give the output a different name.",
    });
  }
  return lines;
}

/** A finding as a human sentence; a rename also shows the new name (what we did). */
function findingText(f: Finding): string {
  if (f.fix?.kind === "rename" && f.fix.to) return `${f.message} → ${f.fix.to}`;
  return f.message;
}

/** The report log: every finding as a natural-language, severity-tagged line,
 *  plus any excluded entry not already covered by a finding (custom excludes,
 *  pruned empty dirs/files) so a dropped path is never hidden. Ordered most-severe
 *  first (errors, warnings, info), stable within a tier. Pure and testable. */
export function planReport(plan: PlanData): ReportLine[] {
  const lines: ReportLine[] = plan.findings.map((f) => ({
    level: f.severity,
    text: findingText(f),
    path: f.path,
  }));
  const covered = new Set(plan.findings.map((f) => f.path));
  for (const e of plan.entries) {
    if (e.excluded && !covered.has(e.archivePath)) {
      lines.push({ level: "info", text: `excluded — ${e.excludeReason ?? "filtered out"}`, path: e.archivePath });
    }
  }
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return lines
    .map((line, i) => ({ line, i }))
    .sort((a, b) => rank[a.line.level] - rank[b.line.level] || a.i - b.i)
    .map(({ line }) => line);
}

/** A local, ISO-ish timestamp for user-facing lines (timestamp-conventions:
 *  user-facing = local time, ISO-ish, English). The event's `time` is the SDK's
 *  internal UTC ISO form; this renders it in the viewer's local zone. Falls back
 *  to the raw value if it cannot be parsed. */
function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** One Progress-log line, with the time shown in local (not raw UTC) form. */
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
 *  Empty string when the path is bare or at the filesystem root. */
export function containingDir(p: string | undefined): string {
  if (!p) return "";
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i <= 0 ? "" : norm.slice(0, i);
}

/**
 * The destination preview shown above Create — the directory the archive lands in
 * and its file name, as two separate concerns. The AUTHORITATIVE composition is
 * the main process's `resolveOutputPath` (it owns `~` expansion and absolute-path
 * validation); this is a DISPLAY preview only. It prefers the SDK-resolved
 * `job.output`, falls back to what the user typed, says "resolving…" only while a
 * plan is actually running, and otherwise names the default the user still needs
 * to see — so it never claims "planning" for a blocked/failed job. One place, so
 * the renderer has a single (tested) derivation instead of an inline ladder.
 */
export function outputPreview(job: Job, opts: GuiOptions): { dir: string; name: string } {
  const name =
    archiveName(job.output) ||
    opts.fileName.trim() ||
    (job.state === "planning" ? "resolving…" : "(set a file name)");
  const dir =
    containingDir(job.output) ||
    opts.outputDir.trim() ||
    containingDir(job.inputs[0]) ||
    "(beside the input)";
  return { dir, name };
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
    case "queued":
      return "rgba(138, 160, 192, 0.12)";
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
