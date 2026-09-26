/**
 * Pure view derivations for the queue screen — the "what to show" logic kept
 * apart from the JSX "how to show it" in App.tsx, so it can be unit-tested
 * without a DOM. No React, no Electron, no Node: Job / Plan / Event data in,
 * strings / booleans / colors out. (This file is in the renderer project, so it
 * must stay Node-free — it carries no `node:*` import and no Node global.)
 *
 * This is also where the SDK's words become the interface's: the SDK keeps
 * stable codes and English text for its CLI and library users, and the GUI
 * maps each code (a finding's rule, an event's name, an error code) to a
 * catalogue entry, so the SDK itself stays language-free. Text a code does not
 * cover (a fault's diagnostic detail, an unknown rule) is shown as the SDK
 * wrote it.
 */

import type { ExtractData, Finding, InputEntry, Job, JobIntent, LogEvent, PathKind, PlanData, Severity } from "../../shared/api";
import type { MessageKey } from "../../shared/i18n/catalogues";
import type { Translator } from "../../shared/i18n/translate";
import type { GuiOptions } from "../../shared/spec";

/** The status palette, in one place so every status reads one map. Each entry is
 *  a theme token (index.css), so inline styles follow the light or dark theme. */
export const COLOR = {
  ok: "var(--status-ok)",
  bad: "var(--status-error)",
  warn: "var(--status-warning)",
  info: "var(--status-info)",
  busy: "var(--status-busy)",
  // Waiting its turn: a muted, desaturated blue — kin to `busy` (it's about to
  // run) but calmer, so "queued" reads as pending rather than active. Picked to
  // sit in the golden-workbench palette; safe to retone alongside the rest.
  queued: "var(--status-queued)",
  ready: "var(--status-ready)",
  idle: "var(--status-idle)",
} as const;

/** A status color at a low strength over whatever is behind it. */
function tint(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

function baseName(p: string): string {
  const norm = p.replace(/\\/g, "/");
  return norm.split("/").pop() || norm;
}

/** A job's label: a single input shows its own name (with extension); multiple
 *  inputs show a quiet count of directories and files (each only when > 0) rather
 *  than a noisy file list. The counts need the on-disk classification (`entries`);
 *  before it resolves it falls back to a plain item count. */
export function label(job: Job, t: Translator): string {
  if (job.inputs.length === 0) return t.t("jobs.noInput");
  if (job.inputs.length === 1) return baseName(job.inputs[0]!);
  const entries = job.entries;
  if (!entries || entries.length === 0) return t.t("jobs.items", { count: job.inputs.length });
  const dirs = entries.filter((e) => e.kind === "directory").length;
  const files = entries.filter((e) => e.kind === "file").length;
  const parts: string[] = [];
  if (dirs > 0) parts.push(t.t("jobs.directories", { count: dirs }));
  if (files > 0) parts.push(t.t("jobs.files", { count: files }));
  // All inputs missing/other: still say something honest.
  return parts.length > 0 ? t.list(parts) : t.t("jobs.items", { count: entries.length });
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

/** The catalogue label for a job state (the raw union is lower-kebab for code).
 *  Exhaustive over JobState so a new state can't slip out unlabelled. */
export function stateLabel(state: Job["state"]): MessageKey {
  switch (state) {
    case "planning":
      return "state.planning";
    case "needs-attention":
      return "state.needsAttention";
    case "ready":
      return "state.ready";
    case "queued":
      return "state.queued";
    case "running":
      return "state.running";
    case "done":
      return "state.done";
    case "failed":
      return "state.failed";
  }
}

/** A standalone user-facing message starts as a sentence, while a leading
 * technical id (`output.exists:`) stays byte-exact and only its explanation is
 * sentence-cased. Paths and other non-letter-led payloads are left alone. */
export function humanSentence(message: string): string {
  const technical = /^([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+):(\s*)(.*)$/s.exec(message);
  if (technical) {
    return `${technical[1]}:${technical[2]}${humanSentence(technical[3] ?? "")}`;
  }
  return message.replace(/^[a-z]/, (first) => first.toUpperCase());
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
export function intentLabel(intent: JobIntent, t: Translator): string {
  return intent === "archive-and-trash" ? t.t("jobs.trashTag") : "";
}

/** One line of the report — a severity level, a human sentence, and the path it
 *  concerns (omitted for the summary line). The renderer colors by `level`. */
export interface ReportLine {
  level: Severity;
  text: string;
  path?: string;
}

/** Plain, actionable GUI guidance for the SDK error codes a user can hit while
 *  setting up a job, keyed on the stable `code` (never the message text). Codes
 *  without an entry fall back to the job's own message. */
const ERROR_GUIDANCE: Record<string, MessageKey> = {
  "output.ambiguous": "guidance.outputAmbiguous",
  "scan.input-missing": "guidance.inputMissing",
  "scan.stat-failed": "guidance.statFailed",
  "scan.walk-failed": "guidance.walkFailed",
};

/** The report's headline sentence: context-aware, factual, and never the vague
 *  "Windows-safe" claim. Speaks to the job's actual state — failed, done, blocked,
 *  or ready (with what the archive will carry / what was auto-handled). */
export function reportSummary(job: Job, plan: PlanData | null, t: Translator): ReportLine | null {
  if (job.state === "failed") {
    return { level: "error", text: job.message ? t.text(job.message) : t.t("report.createFailed") };
  }
  // A blocked job must ALWAYS explain itself, even when the plan threw and left no
  // structured data (plan === null) — the captured message is the only explanation
  // the user gets, so never swallow it. Prefer friendly guidance keyed on the SDK
  // error code; fall back to the structured count, then the raw message.
  if (job.state === "needs-attention") {
    const guidance = job.errorCode ? ERROR_GUIDANCE[job.errorCode] : undefined;
    if (guidance) return { level: "error", text: t.t(guidance) };
    if (plan) {
      return { level: "error", text: t.t("report.blockingIssues", { count: plan.summary.errors }) };
    }
    return { level: "error", text: job.message ? t.text(job.message) : t.t("report.cannotArchiveYet") };
  }
  if (!plan) return null; // planning — nothing to report yet
  const s = plan.summary;
  if (job.state === "done") {
    return { level: "info", text: t.t("report.archived", { count: s.included }) };
  }
  const notes: string[] = [];
  if (s.renamed > 0) notes.push(t.t("report.renamedNote", { count: s.renamed }));
  if (s.excluded > 0) notes.push(t.t("report.excludedNote", { count: s.excluded }));
  if (s.warnings > 0) notes.push(t.t("report.warningsNote", { count: s.warnings }));
  return {
    level: s.warnings > 0 ? "warning" : "info",
    text:
      notes.length > 0
        ? t.t("report.readyWithNotes", { count: s.included, notes: t.list(notes) })
        : t.t("report.ready", { count: s.included }),
  };
}

/** GUI-side advisories about the inputs themselves — guidance the SDK doesn't
 *  emit (it isn't an archive fault, just advice). Currently: a lone `.zip` input
 *  gains little from re-compression and would only nest. Shown in the Report so
 *  the user sees it before creating. */
export function jobAdvisories(job: Job, t: Translator): ReportLine[] {
  const lines: ReportLine[] = [];
  const onlyInput = job.inputs.length === 1 ? job.inputs[0] : undefined;
  const isFile = job.entries?.[0]?.kind === "file";
  if (onlyInput && isFile && /\.zip$/i.test(onlyInput)) {
    lines.push({ level: "warning", text: t.t("report.zipInput") });
  }
  return lines;
}

/** The name rules: one entry for a name the SDK repaired, one for a name it
 *  only reported. The SDK marks a repair by giving the finding its rename
 *  target (`fix.kind === "rename"`). */
const NAME_FINDINGS: Record<string, { fixed: MessageKey; found: MessageKey }> = {
  "name.nfd": { fixed: "finding.nfdFixed", found: "finding.nfd" },
  "name.invalid-char": { fixed: "finding.invalidCharFixed", found: "finding.invalidChar" },
  "name.control-char": { fixed: "finding.controlCharFixed", found: "finding.controlChar" },
  "name.trailing-dot-space": { fixed: "finding.trailingDotSpaceFixed", found: "finding.trailingDotSpace" },
  "name.reserved": { fixed: "finding.reservedFixed", found: "finding.reserved" },
};

/** The rules whose text depends on nothing but the rule itself. */
const RULE_FINDINGS: Record<string, MessageKey> = {
  "path.absolute": "finding.pathAbsolute",
  "path.traversal": "finding.pathTraversal",
  "path.too-long": "finding.pathTooLong",
  "macos.junk": "finding.junk",
  "windows.junk": "finding.junk",
  "linux.junk": "finding.junk",
  "name.suspicious": "finding.suspicious",
  "entry.duplicate": "finding.duplicate",
  "collision.case": "finding.collisionCase",
  "collision.post-fix": "finding.collisionPostFix",
  "time.pre-1980": "finding.pre1980",
  "time.post-2107": "finding.post2107",
  "output.exists": "finding.outputExists",
};

/** The catalogue entry for a plan finding, keyed on its stable rule, or null
 *  for a rule the GUI does not know (shown as the SDK wrote it). A symlink
 *  finding reads from the plan whether the link was kept or dropped: the SDK
 *  excludes the entry it ignores. */
export function findingKey(f: Finding, plan: PlanData): MessageKey | null {
  const name = NAME_FINDINGS[f.rule];
  if (name) return f.fix?.kind === "rename" ? name.fixed : name.found;
  if (f.rule === "entry.symlink") {
    const entry = plan.entries.find((e) => e.archivePath === f.path);
    return entry?.excluded ? "finding.symlinkIgnored" : "finding.symlinkPreserved";
  }
  return RULE_FINDINGS[f.rule] ?? null;
}

/** A finding as a human sentence; a rename also shows the new name (what we did). */
function findingText(f: Finding, plan: PlanData, t: Translator): string {
  const key = findingKey(f, plan);
  const text = key ? t.t(key) : humanSentence(f.message);
  if (f.fix?.kind === "rename" && f.fix.to) return t.t("finding.renamedTo", { text, to: f.fix.to });
  return text;
}

/** The SDK's reasons for an exclusion no finding explains. The SDK writes them
 *  as fixed English phrases rather than codes, so these phrases are the key;
 *  one the table does not know is shown as the SDK wrote it. */
const EXCLUDE_REASONS: Record<string, MessageKey> = {
  "empty directory pruned": "report.excludedEmptyDir",
  "empty file skipped": "report.excludedEmptyFile",
};

function excludedText(reason: string | undefined, t: Translator): string {
  if (reason === undefined) return t.t("report.excludedFiltered");
  const key = EXCLUDE_REASONS[reason];
  return key ? t.t(key) : t.t("report.excludedReason", { reason });
}

/** The report log: every finding as a natural-language, severity-tagged line,
 *  plus any excluded entry not already covered by a finding (custom excludes,
 *  pruned empty dirs/files) so a dropped path is never hidden. Ordered most-severe
 *  first (errors, warnings, info), stable within a tier. Pure and testable. */
export function planReport(plan: PlanData, t: Translator): ReportLine[] {
  const lines: ReportLine[] = plan.findings.map((f) => ({
    level: f.severity,
    text: findingText(f, plan, t),
    path: f.path,
  }));
  const covered = new Set(plan.findings.map((f) => f.path));
  for (const e of plan.entries) {
    if (e.excluded && !covered.has(e.archivePath)) {
      lines.push({ level: "info", text: excludedText(e.excludeReason, t), path: e.archivePath });
    }
  }
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return lines
    .map((line, i) => ({ line, i }))
    .sort((a, b) => rank[a.line.level] - rank[b.line.level] || a.i - b.i)
    .map(({ line }) => line);
}

/** A user-facing timestamp in the viewer's zone and the interface's locale
 *  format, to the second (timestamp-conventions). The event's `time` is the
 *  SDK's internal UTC ISO form. Falls back to the raw value if it cannot be
 *  parsed. */
function formatLocalTime(iso: string, t: Translator): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return t.logTime(d);
}

/** One Progress-log line, in the three parts the log paints separately: the time
 *  in local (not raw UTC) form, the human level, and the message. They stay
 *  apart rather than being joined here, because the log gives each its own
 *  weight and colour. */
export function eventLineParts(event: LogEvent, t: Translator): { time: string; level: string; message: string } {
  return {
    time: formatLocalTime(event.time, t),
    level: t.t(logLevelLabel(event.level)),
    message: progressMessage(event, t),
  };
}

/** The colour the Progress log paints a level in. A log is mostly routine, so
 *  only the levels worth stopping at take a status colour; debug and info stay
 *  in the secondary text colour and let the messages read as one column. */
export function logLevelColor(level: LogEvent["level"]): string {
  switch (level) {
    case "error":
      return COLOR.bad;
    case "warn":
      return COLOR.warn;
    case "info":
    case "debug":
      return "var(--text-2)";
  }
}

/** Catalogue labels for the machine-readable logging levels. */
export function logLevelLabel(level: LogEvent["level"]): MessageKey {
  switch (level) {
    case "debug":
      return "log.debug";
    case "info":
      return "log.info";
    case "warn":
      return "log.warn";
    case "error":
      return "log.error";
  }
}

/** The Progress line for a typed SDK event, rendered from the event's own
 *  fields rather than from the SDK's English `message`. The structured event,
 *  its JSONL message, and its wire literals remain untouched. A fault keeps
 *  its code and diagnostic detail as the SDK wrote them. */
export function progressMessage(event: LogEvent, t: Translator): string {
  switch (event.event) {
    case "session.start":
      return t.t("event.sessionStart", {
        version: event.version,
        concurrency: event.concurrency,
        chunkSize: event.chunkSize,
      });
    case "scan.start":
      return t.t("event.scanStart", { count: event.inputs });
    case "scan.dir":
      return t.t("event.scanDir", { path: event.path });
    case "scan.symlink-unreadable":
      return t.t("event.symlinkUnreadable", { path: event.path });
    case "scan.done":
      return t.t("event.scanDone", {
        counts: t.list([
          t.t("report.entries", { count: event.entries }),
          t.t("event.prunedDirs", { count: event.prunedDirs }),
        ]),
      });
    case "plan.done":
      return t.t("event.planDone", {
        counts: t.list([
          t.t("event.included", { count: event.included }),
          t.t("event.excludedCount", { count: event.excluded }),
          t.t("event.renamedCount", { count: event.renamed }),
          t.t("event.warnings", { count: event.warnings }),
          t.t("event.errors", { count: event.errors }),
        ]),
      });
    case "entry.excluded":
      return t.t("event.excluded", { path: event.path });
    case "entry.renamed":
      return t.t("event.renamed", { from: event.from, path: event.path });
    case "entry.flagged":
      return t.t("event.flagged", { rule: event.rule, path: event.path });
    case "write.start":
      return t.t("event.writeStart", { count: event.entries });
    case "entry.written":
      return t.t("event.written", { path: event.path });
    case "write.done":
      return t.t(event.zip64 ? "event.writeDoneZip64" : "event.writeDone", { count: event.bytes });
    case "extract.start":
      return t.t(event.write ? "event.extractStart" : "event.verifyStart", { count: event.entries });
    case "entry.verified":
      return t.t("event.verified", { path: event.path });
    case "extract.done":
      return t.t("event.extractDone", {
        counts: t.list([
          t.t("event.writtenCount", { count: event.written }),
          t.t("event.skippedCount", { count: event.skipped }),
          t.t("report.crcFailures", { count: event.crcFailed }),
          t.t("report.shaMismatches", { count: event.shaMismatched }),
        ]),
      });
    case "fault":
      return event.cause !== undefined
        ? `${event.code}: ${event.detail}: ${event.cause}`
        : `${event.code}: ${event.detail}`;
  }
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
export function outputPreview(job: Job, opts: GuiOptions, t: Translator): { dir: string; name: string } {
  const name =
    archiveName(job.output) ||
    opts.fileName.trim() ||
    t.t(job.state === "planning" ? "dest.resolving" : "dest.setFileName");
  const dir =
    containingDir(job.output) ||
    opts.outputDir.trim() ||
    containingDir(job.inputs[0]) ||
    t.t("dest.besideInput");
  return { dir, name };
}

/** A subtle row-background tint per job state, for at-a-glance distinction in the
 *  list. Kept low-contrast so the text stays readable over it. */
export function stateTint(state: Job["state"]): string {
  switch (state) {
    case "planning":
      return "transparent";
    case "needs-attention":
      return tint(COLOR.warn, 12);
    case "ready":
      return tint(COLOR.ready, 14);
    case "queued":
      return tint(COLOR.queued, 12);
    case "running":
      return tint(COLOR.busy, 12);
    case "done":
      return tint(COLOR.ok, 14);
    case "failed":
      return tint(COLOR.bad, 14);
  }
}

/** The verify result one-liner. */
export function verifySummary(data: ExtractData, t: Translator): string {
  const s = data.summary;
  return t.list([
    t.t("report.entries", { count: s.total }),
    t.t("report.crcFailures", { count: s.crcFailed }),
    t.t("report.shaMismatches", { count: s.shaMismatched }),
  ]);
}
