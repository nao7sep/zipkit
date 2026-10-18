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

import { diffChars } from "diff";
import { JOB_EVENT_LIMIT } from "../../shared/api";
import { manifestRequiredButMissing, originalsIntact, present, removesOriginals, scanBlocksRemoval } from "../../shared/queue";
import type { Finding, InputEntry, Job, PlannedEntry, JobAction, JobEvent, JobIntent, LogEvent, PathKind, ProgressCounts, Severity } from "../../shared/api";
import { renamedItself, type PlanReport } from "../../shared/plan-report";
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

/** A job's label: the name of the first input as the Inputs list orders it,
 *  so every job is told apart by a real name however many inputs it archives;
 *  the counts line beside it says how many there are. Before the inputs are
 *  classified, both the list and the label use the order they were added. */
export function label(job: Job, t: Translator): string {
  if (job.inputs.length === 0) return t.t("jobs.noInput");
  const ordered = job.entries && job.entries.length > 0 ? orderedEntries(job.entries) : [];
  return baseName(ordered[0]?.path ?? job.inputs[0]!);
}

/** One count in a job's counts line; a severity colours the ones to look at. */
export type JobCount = { text: string; severity?: "warning" | "error" };

const COUNT_KEYS: Record<PathKind, MessageKey> = {
  directory: "jobs.countFolders",
  file: "jobs.countFiles",
  missing: "jobs.countMissing",
  unavailable: "jobs.countUnavailable",
  other: "jobs.countOther",
};

/** What a job holds, for its row, most important first so a narrow row cuts
 *  the least: what its plan could not include, warned about and excluded, each
 *  only when there is any, then the inputs by kind (only the kinds present, in
 *  the Inputs list's order). Before classification the inputs are one plain
 *  count; before planning there is no plan part. */
export function jobCounts(job: Job, t: Translator): JobCount[] {
  const counts: JobCount[] = [];
  const summary = job.summary;
  if (summary) {
    if (summary.errors > 0) counts.push({ text: t.t("jobs.countErrors", { count: summary.errors }), severity: "error" });
    if (summary.warnings > 0) counts.push({ text: t.t("jobs.countWarnings", { count: summary.warnings }), severity: "warning" });
    if (summary.excluded > 0) counts.push({ text: t.t("jobs.countExcluded", { count: summary.excluded }) });
  }
  if (job.entries && job.entries.length > 0) {
    for (const kind of ["directory", "file", "missing", "unavailable", "other"] as const) {
      const count = job.entries.filter((entry) => entry.kind === kind).length;
      if (count > 0) counts.push({ text: t.t(COUNT_KEYS[kind], { count }) });
    }
  } else if (job.inputs.length > 0) {
    counts.push({ text: t.t("jobs.countItems", { count: job.inputs.length }) });
  }
  return counts;
}

/** Whether any of the job's originals still exist on disk, so trashing them is
 *  meaningful. Uses the classified `entries`; if they are not yet known, assume
 *  present (the engine re-checks before it trashes anything). */
export function originalsPresent(job: Job): boolean {
  if (!job.entries) return true;
  return job.entries.some(present);
}

/** Display order for the input list: directories first, then files, then anything
 *  else (other / missing) last; within each group, full paths sorted alphabetically
 *  (case-insensitive). Pure, so the order is testable without a DOM. */
const KIND_RANK: Record<PathKind, number> = { directory: 0, file: 1, other: 2, missing: 3, unavailable: 4 };
export function orderedEntries(entries: InputEntry[]): InputEntry[] {
  return [...entries].sort((a, b) => {
    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    return byKind !== 0 ? byKind : a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
  });
}

/** The state label color for each job state (exhaustive over JobState). */
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

/** Jobs that can be cancelled: in-flight work (`planning`/`running`), waiting
 *  its turn (`queued`), or a job moving its archive or originals to Trash.
 *  Cancelling a run re-plans the job back to an editable state. Drives the
 *  listbox Cancel affordance (button + Escape). */
export function isCancelable(job: Job): boolean {
  return job.state === "planning" || job.state === "queued" || job.state === "running" || job.trashing === true;
}

/** A per-job lifecycle command for the right-pane command bar. */
export type JobCommand =
  | "create"
  | "retry"
  | "cancel"
  | "verify"
  | "reveal"
  | "trash-originals"
  | "delete-originals"
  | "remove-archive";

export { manifestRequiredButMissing, scanBlocksRemoval };

/** The lifecycle commands available for a job in its current state. Pure, so the
 *  command bar reads one source and is unit-tested without a DOM. `needs-attention`
 *  intentionally offers none — the job is blocked until its options are fixed —
 *  and neither does a job that removes its originals without its manifest or
 *  with a folder its scan could not list, whose note says why. */
export function jobCommands(job: Job): JobCommand[] {
  // Moving the archive or the originals to Trash on request: busy until it ends or is cancelled.
  if (job.trashing) return ["cancel"];
  const runnable = !manifestRequiredButMissing(job.intent, job.options.metadata) && !scanBlocksRemoval(job);
  switch (job.state) {
    case "planning":
      return ["cancel"];
    case "needs-attention":
      // Still writable only when Create stopped because the files changed since
      // the Report was read: the user reviews the fresh one, then creates.
      return job.writable === true && runnable ? ["create"] : [];
    case "ready":
      return runnable ? ["create"] : [];
    case "queued":
      // Waiting its turn: the only act is to pull it back out of the queue.
      return ["cancel"];
    case "running":
      return ["cancel"];
    case "failed":
      // If the archive was written but a later step failed (its checks or the
      // removal of the originals failed, so the .zip exists), let the user
      // inspect it, retry from it, or move it to Trash — unless some originals
      // were deleted for good, when the archive is all that is left of them. A
      // write failure leaves no archive, so it offers only "Try again" (the
      // planned `output` names where it would have gone, not a file).
      if (job.archiveWritten) {
        const after: JobCommand[] = job.intent.originals !== "delete" || originalsIntact(job)
          ? ["reveal", "remove-archive"] : ["reveal"];
        return runnable ? ["retry", ...after] : after;
      }
      return runnable ? ["retry"] : [];
    case "done": {
      // An archive gone after the originals were removed, or out of reach,
      // leaves nothing to act on until it is back.
      if (job.archiveStatus === "missing" || job.archiveStatus === "unavailable") return [];
      // Verify is offered until the archive verifies, and again once it changes.
      const verify: JobCommand[] = job.archiveStatus === "verified" ? [] : ["verify"];
      // Verify/reveal the archive, move it to Trash while every original is
      // still there (to edit and re-create), or — while some are there, put
      // back from the Trash after a run removed them included, and only when
      // the archive carries the manifest the checks need — remove the
      // originals. The destructive commands come last; the command bar gives
      // them a row of their own.
      const commands: JobCommand[] = [...verify, "reveal"];
      // A run that removed the originals offers them again only once a fresh
      // look finds some back: before that, nothing is known to be there.
      if (removesOriginals(job.intent) && job.entries === undefined) return commands;
      if (originalsIntact(job)) commands.push("remove-archive");
      if (job.options.metadata && !job.scanIncomplete && originalsPresent(job)) commands.push("trash-originals", "delete-originals");
      return commands;
    }
  }
}

/** The short intent tag shown on a job row — only the noteworthy intent gets a
 *  tag; the plain "save" is the default and adds no signal, so it shows nothing. */
export function intentLabel(intent: JobIntent, t: Translator): string {
  if (intent.originals === "trash") return t.t("jobs.trashTag");
  if (intent.originals === "delete") return t.t("jobs.deleteTag");
  return "";
}

/** One line of the report outside the plan's files — the summary, an advisory,
 *  a verify result — as a severity level and a human sentence. The renderer
 *  colors by `level`. */
export interface ReportLine {
  level: Severity;
  text: string;
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
export function reportSummary(
  job: Job, plan: PlanReport | null, t: Translator,
  groups: readonly ReportGroup[] = plan ? planReport(plan, t) : [],
): ReportLine | null {
  if (job.state === "failed") {
    return { level: "error", text: job.message ? t.text(job.message) : t.t("report.createFailed") };
  }
  // A blocked job must ALWAYS explain itself, even when the plan threw and left no
  // structured data (plan === null) — the captured message is the only explanation
  // the user gets, so never swallow it. Prefer friendly guidance keyed on the SDK
  // error code; fall back to the structured count, then the raw message.
  if (job.state === "needs-attention" && job.writable === true && job.message) {
    return { level: "warning", text: t.text(job.message) };
  }
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
    return { level: "info", text: t.t(job.archiveStatus === "verified" ? "report.archivedVerified" : "report.archived", { count: s.included }) };
  }
  const notes: string[] = [];
  // Counted as the Report's Renamed rows, so a renamed folder counts once, as
  // it is listed, not once per file inside it.
  const renamed = groups.find((g) => g.kind === "renamed")?.rows.length ?? 0;
  if (renamed > 0) notes.push(t.t("report.renamedNote", { count: renamed }));
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
  // Before a run, an input that went or is out of reach is worth saying at
  // once; after one, the history says what happened to the originals.
  if (job.state !== "done" && job.state !== "failed" && job.state !== "running") {
    const missing = job.entries?.filter((entry) => entry.kind === "missing").length ?? 0;
    const unavailable = job.entries?.filter((entry) => entry.kind === "unavailable").length ?? 0;
    if (missing > 0) lines.push({ level: "warning", text: t.t("report.inputMissing", { count: missing }) });
    if (unavailable > 0) lines.push({ level: "warning", text: t.t("report.inputUnavailable", { count: unavailable }) });
  }
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
  "entry.unsupported": "finding.unsupported",
  "entry.unlisted": "finding.unlisted",
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
export function findingKey(f: Finding, excluded = false): MessageKey | null {
  const name = NAME_FINDINGS[f.rule];
  if (name) return f.fix?.kind === "rename" ? name.fixed : name.found;
  if (f.rule === "entry.symlink") {
    return excluded ? "finding.symlinkIgnored" : "finding.symlinkPreserved";
  }
  return RULE_FINDINGS[f.rule] ?? null;
}

/** A finding as a human sentence; one the GUI does not know reads as the SDK
 *  wrote it. */
function findingText(f: Finding, t: Translator, excluded = false): string {
  const key = findingKey(f, excluded);
  return key ? t.t(key) : humanSentence(f.message);
}

/** Why an entry no finding explains was left out, keyed on the SDK's stable
 *  exclusion code; a filter rule is named as the SDK describes it. */
function excludedText(entry: Pick<PlannedEntry, "excludeCode" | "excludeReason">, t: Translator): string {
  if (entry.excludeCode === "empty-dir") return t.t("report.excludedEmptyDir");
  if (entry.excludeCode === "empty-file") return t.t("report.excludedEmptyFile");
  return entry.excludeReason === undefined ? t.t("report.excludedFiltered") : t.t("report.excludedReason", { reason: entry.excludeReason });
}

/** The rules whose finding already says why its entry was left out. */
const EXCLUDING_RULES = new Set([
  "macos.junk",
  "windows.junk",
  "linux.junk",
  "path.traversal",
  "entry.symlink",
  "entry.unsupported",
  "entry.duplicate",
]);

/** One file of the Report (or the archive itself, for a finding about the
 *  output): its path in the archive, its name on disk when the plan renamed
 *  it, and each change the plan makes to it or finds in it, in plain words. */
export interface ReportRow {
  path: string;
  from?: string;
  changes: string[];
  /** Whether the row is a folder; a finding with no entry counts as a file. */
  dir?: boolean;
}

/** The kinds the Report groups its rows by, in the order they are shown. A row
 *  goes to the first kind it qualifies for. */
export const REPORT_GROUPS = ["blocking", "warnings", "renamed", "excluded", "notes"] as const;
export type ReportGroupKind = (typeof REPORT_GROUPS)[number];

export interface ReportGroup {
  kind: ReportGroupKind;
  rows: ReportRow[];
}

function severityGroup(findings: readonly Finding[]): ReportGroupKind | null {
  if (findings.some((f) => f.severity === "error")) return "blocking";
  if (findings.some((f) => f.severity === "warning")) return "warnings";
  return null;
}

/** The Report's files: one row per file the plan changes or has a finding on,
 *  with every change it makes to that file, grouped by kind. Each entry's own
 *  findings are its changes; a finding no entry carries (the output already
 *  existing) is a row of its own. An entry whose only change is a renamed
 *  folder above it (every file of a renamed `.pages` bundle) gets no row. Pure
 *  and testable. */
export function planReport(plan: PlanReport, t: Translator): ReportGroup[] {
  const rows: Record<ReportGroupKind, ReportRow[]> = { blocking: [], warnings: [], renamed: [], excluded: [], notes: [] };
  const findingId = (f: Finding): string => `${f.rule}\0${f.path}\0${f.message}`;
  const onEntries = new Set<string>();

  for (const entry of plan.entries) {
    const findings = entry.findings;
    for (const f of findings) onEntries.add(findingId(f));
    const changes = [...new Set(findings.map((f) => findingText(f, t, entry.excluded)))];
    if (entry.excluded && !findings.some((f) => EXCLUDING_RULES.has(f.rule))) {
      changes.push(excludedText(entry, t));
    }
    const renamed = renamedItself(entry);
    if (changes.length === 0 && !renamed) continue;
    const kind = severityGroup(findings) ?? (entry.excluded ? "excluded" : renamed ? "renamed" : "notes");
    const dir = entry.type === "dir" ? { dir: true } : {};
    rows[kind].push(renamed ? { path: entry.archivePath, from: entry.originalPath, changes, ...dir } : { path: entry.archivePath, changes, ...dir });
  }
  for (const f of plan.findings) {
    if (onEntries.has(findingId(f))) continue;
    rows[severityGroup([f]) ?? "notes"].push({ path: f.path, changes: [findingText(f, t)] });
  }
  return REPORT_GROUPS.filter((kind) => rows[kind].length > 0).map((kind) => ({ kind, rows: rows[kind] }));
}

/** One run of a renamed path as shown: kept as it was, removed from the name
 *  on disk, or added in the archive. */
export interface RenamePart {
  text: string;
  change: "kept" | "removed" | "added";
}

/**
 * How a renamed row shows its path. A name whose only change is NFD to NFC
 * looks the same before and after, so it is shown once (`same`) and its
 * change list says what changed. Any other rename is one path with the
 * removed and added characters marked, compared after NFC so a decomposed
 * name shows only its real substitutions. Diffed by code point, so an emoji
 * or a combined character is never split.
 */
export function renameDisplay(from: string, path: string): { kind: "same" } | { kind: "changed"; parts: RenamePart[] } {
  const before = from.normalize("NFC");
  if (before === path) return { kind: "same" };
  return {
    kind: "changed",
    parts: diffChars(before, path).map((part) => ({
      text: part.value,
      change: part.added ? "added" : part.removed ? "removed" : "kept",
    })),
  };
}

/** The Progress labels for the name rules, a fixed and a found form each. */
const NAME_KINDS: Record<string, { fixed: MessageKey; found: MessageKey }> = {
  "name.nfd": { fixed: "findingKind.nfdFixed", found: "findingKind.nfd" },
  "name.invalid-char": { fixed: "findingKind.invalidCharFixed", found: "findingKind.invalidChar" },
  "name.control-char": { fixed: "findingKind.controlCharFixed", found: "findingKind.controlChar" },
  "name.trailing-dot-space": { fixed: "findingKind.trailingDotSpaceFixed", found: "findingKind.trailingDotSpace" },
  "name.reserved": { fixed: "findingKind.reservedFixed", found: "findingKind.reserved" },
};

/** The Progress label for every other rule, plan and verify alike: a short
 *  noun phrase that names the kind, where the Report's sentence describes one
 *  entry. */
const RULE_KINDS: Record<string, MessageKey> = {
  "path.absolute": "findingKind.pathAbsolute",
  "path.traversal": "findingKind.pathTraversal",
  "path.too-long": "findingKind.pathTooLong",
  "macos.junk": "findingKind.junk",
  "windows.junk": "findingKind.junk",
  "linux.junk": "findingKind.junk",
  "entry.symlink": "findingKind.symlink",
  "entry.unsupported": "findingKind.unsupported",
  "entry.unlisted": "findingKind.unlisted",
  "name.suspicious": "findingKind.suspicious",
  "entry.duplicate": "findingKind.duplicate",
  "collision.case": "findingKind.collisionCase",
  "collision.post-fix": "findingKind.collisionPostFix",
  "time.pre-1980": "findingKind.pre1980",
  "time.post-2107": "findingKind.post2107",
  "output.exists": "findingKind.outputExists",
  "extract.crc-fail": "findingKind.crcFail",
  "extract.sha-mismatch": "findingKind.shaMismatch",
  "extract.manifest-mismatch": "findingKind.manifestMismatch",
  "extract.unsafe-path": "findingKind.unsafePath",
  "extract.missing": "findingKind.missing",
  "extract.extra": "findingKind.extra",
};

/** The label for a kind of finding in Progress, from its rule and the severity
 *  the run gave it — a progress event carries no fix, and a name rule is
 *  reported at `info` exactly when it was repaired. A rule the GUI does not
 *  know shows its code. */
export function findingKind(rule: string, severity: Severity, t: Translator): string {
  const name = NAME_KINDS[rule];
  if (name) return t.t(severity === "info" ? name.fixed : name.found);
  const key = RULE_KINDS[rule];
  return key ? t.t(key) : rule;
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

const RUN_HEADINGS: Record<JobAction, MessageKey> = {
  plan: "progress.runPlan",
  create: "progress.runCreate",
  verify: "progress.runVerify",
  trash: "progress.runTrash",
  delete: "progress.runDelete",
};

/** How far a write or a verification has got: the share done, by bytes when
 *  there are any and else by items, and the line that says both. */
export function countsView(counts: ProgressCounts, t: Translator): { fraction: number; text: string } {
  const items = { entriesDone: counts.entriesDone, entriesTotal: counts.entriesTotal };
  if (counts.bytesTotal > 0) {
    return {
      fraction: Math.min(1, counts.bytesDone / counts.bytesTotal),
      text: t.t("details.progressCounts", { ...items, bytesDone: { bytes: counts.bytesDone }, bytesTotal: { bytes: counts.bytesTotal } }),
    };
  }
  return {
    fraction: counts.entriesTotal > 0 ? Math.min(1, counts.entriesDone / counts.entriesTotal) : 0,
    text: t.t("details.progressItems", items),
  };
}

/** A Progress run's heading: the action that started it and its start time,
 *  in local form. */
export function progressHeading(run: ProgressRun, t: Translator): string {
  return t.t(RUN_HEADINGS[run.action], { time: formatLocalTime(run.time, t) });
}

/** A Progress line: one SDK event, or a run's findings of one kind folded into
 *  a count. An event line knows whether its run's read was a dry run, so a
 *  verify ends with its own result line. */
export type ProgressLine =
  | { kind: "event"; level: LogEvent["level"]; event: LogEvent; dryRun: boolean }
  | { kind: "findings"; level: LogEvent["level"]; rule: string; severity: Severity; count: number };

/** One run of an action on a job — a plan, a Create, a Verify — headed once
 *  by its action and start time, with its lines below. `key` is its first
 *  event's identity. */
export interface ProgressRun {
  key: string;
  action: JobAction;
  time: string;
  lines: ProgressLine[];
}

/** A job's events as Progress runs: a run is every event one action caused
 *  (main tags each with its run), so a Create's fresh plan, write and verify
 *  read as one, and its findings fold into one line per kind. The SDK's
 *  once-per-launch startup line belongs to no job and is left out. */
export function progressRuns(events: readonly JobEvent[]): ProgressRun[] {
  const runs: ProgressRun[] = [];
  let run: ProgressRun | null = null;
  let runId = "";
  let dryRun = false;
  let folded = new Map<string, Extract<ProgressLine, { kind: "findings" }>>();
  for (const { session, seq, action, run: eventRun, event } of events) {
    if (event.event === "session.start") continue;
    const id = `${session}\0${eventRun}`;
    if (!run || id !== runId) {
      run = { key: `${session}:${seq}`, action, time: event.time, lines: [] };
      runs.push(run);
      runId = id;
      dryRun = false;
      folded = new Map();
    }
    if (event.event === "extract.start") dryRun = !event.write;
    if (event.event === "entry.flagged") {
      const kind = `${event.rule}\0${event.severity}`;
      const line = folded.get(kind);
      if (line) {
        line.count += 1;
      } else {
        const created: Extract<ProgressLine, { kind: "findings" }> = {
          kind: "findings",
          level: event.level,
          rule: event.rule,
          severity: event.severity,
          count: 1,
        };
        folded.set(kind, created);
        run.lines.push(created);
      }
      continue;
    }
    run.lines.push({ kind: "event", level: event.level, event, dryRun });
  }
  return runs;
}

/** A Progress line's text. */
export function progressLineText(line: ProgressLine, t: Translator): string {
  return line.kind === "event"
    ? progressMessage(line.event, t, line.dryRun)
    : t.t("progress.findings", { kind: findingKind(line.rule, line.severity, t), count: line.count });
}

function eventOrder(a: JobEvent, b: JobEvent): number {
  return a.session < b.session ? -1 : a.session > b.session ? 1 : a.seq - b.seq;
}

/** The events of `held` and `arriving` as one list, each event once, in the
 *  order they happened, keeping the newest `JOB_EVENT_LIMIT`. */
export function mergeJobEvents(held: readonly JobEvent[], arriving: readonly JobEvent[]): JobEvent[] {
  const last = held[held.length - 1];
  const first = arriving[0];
  const appends =
    (!last || !first || eventOrder(last, first) < 0) &&
    arriving.every((event, i) => i === 0 || eventOrder(arriving[i - 1]!, event) < 0);
  let merged: JobEvent[];
  if (appends) {
    merged = [...held, ...arriving];
  } else {
    const byId = new Map<string, JobEvent>();
    for (const event of [...held, ...arriving]) byId.set(`${event.session}:${event.seq}`, event);
    merged = [...byId.values()].sort(eventOrder);
  }
  return merged.length > JOB_EVENT_LIMIT ? merged.slice(-JOB_EVENT_LIMIT) : merged;
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
 *  its code and diagnostic detail as the SDK wrote them. `dryRun` says the
 *  read this event ends wrote nothing, so `extract.done` reads as a verify. */
export function progressMessage(event: LogEvent, t: Translator, dryRun = false): string {
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
      return t.t("progress.findings", { kind: findingKind(event.rule, event.severity, t), count: 1 });
    case "write.start":
      return t.t("event.writeStart", { count: event.entries });
    case "entry.written":
      return t.t("event.written", { path: event.path });
    case "write.done":
      return t.t(event.zip64 ? "event.writeDoneZip64" : "event.writeDone", { size: { bytes: event.bytes } });
    case "extract.start":
      return t.t(event.write ? "event.extractStart" : "event.verifyStart", { count: event.entries });
    case "entry.verified":
      return t.t("event.verified", { path: event.path });
    case "extract.done":
      if (dryRun) {
        return t.t("event.verifyDone", {
          counts: t.list([
            t.t("report.entries", { count: event.total }),
            t.t("report.crcFailures", { count: event.crcFailed }),
            t.t("report.shaMismatches", { count: event.shaMismatched }),
            t.t("report.manifestMismatches", { count: event.manifestMismatched }),
          ]),
        });
      }
      return t.t("event.extractDone", {
        counts: t.list([
          t.t("event.writtenCount", { count: event.written }),
          t.t("event.skippedCount", { count: event.skipped }),
          t.t("report.crcFailures", { count: event.crcFailed }),
          t.t("report.shaMismatches", { count: event.shaMismatched }),
          t.t("report.manifestMismatches", { count: event.manifestMismatched }),
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
 * and its file name, as two separate concerns. The AUTHORITATIVE path is the
 * SDK's, from the folder and name main hands it (`outputRequest` owns `~`
 * expansion and absolute-path validation); this is a DISPLAY preview only. It prefers the SDK-resolved
 * `job.output`, falls back to what the user typed, leaves the name empty while a
 * plan is actually running (the state label says so; a stand-in value would not),
 * and otherwise names the default the user still needs to see — so it never
 * claims "planning" for a blocked/failed job. One place, so
 * the renderer has a single (tested) derivation instead of an inline ladder.
 */
export function outputPreview(job: Job, opts: GuiOptions, t: Translator): { dir: string; name: string } {
  const name =
    archiveName(job.output) ||
    opts.fileName.trim() ||
    (job.state === "planning" ? "" : t.t("dest.setFileName"));
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

/** One card of the Details pane: one kind of thing found about the job, its
 *  inputs or its archive, coloured by how much it matters. */
export interface DetailsCard {
  key: string;
  title: string;
  level: Severity;
  rows: ReportRow[];
  /** The names the card lists, each once with how many rows carry it. */
  names: Array<{ name: string; count: number }>;
  /** Whether it lists its names: a card with no more names than the user's
   *  limit does; a longer one shows its count, and Details lists every path. */
  open: boolean;
  /** Whether the count is left out: a card about the one archive a job makes
   *  is not a list of them. */
  countless?: boolean;
  /** What every row says alike, said once in Details rather than per row. */
  common?: string;
  /** What this kind of thing is and what ZipKit does about it, for Details. */
  about?: string;
  /** One line under the title, such as where excluded items go. */
  note?: string;
  /** The facts a card states instead of rows, such as the archive's size. */
  facts?: Array<{ label: string; value: string }>;
}

/** What each kind of finding is and what ZipKit does about it. */
const KIND_INFO: Record<string, MessageKey> = {
  "name.nfd": "kindInfo.nfd",
  "name.invalid-char": "kindInfo.invalidChar",
  "name.control-char": "kindInfo.controlChar",
  "name.trailing-dot-space": "kindInfo.trailingDotSpace",
  "name.reserved": "kindInfo.reserved",
  "name.suspicious": "kindInfo.suspicious",
  "collision.case": "kindInfo.collision",
  "collision.post-fix": "kindInfo.collision",
  "path.absolute": "kindInfo.paths",
  "path.traversal": "kindInfo.paths",
  "path.too-long": "kindInfo.pathTooLong",
  "macos.junk": "kindInfo.junk",
  "windows.junk": "kindInfo.junk",
  "linux.junk": "kindInfo.junk",
  "entry.duplicate": "kindInfo.duplicate",
  "entry.symlink": "kindInfo.symlink",
  "entry.unsupported": "kindInfo.special",
  "entry.unlisted": "kindInfo.special",
  "time.pre-1980": "kindInfo.dates",
  "time.post-2107": "kindInfo.dates",
  "output.exists": "kindInfo.outputExists",
};

const JUNK_RULES = new Set(["macos.junk", "windows.junk", "linux.junk"]);

/** The separator a path written by the computer uses: a Windows path has a
 *  drive or a backslash and no forward slash. */
function separatorOf(p: string): "/" | "\\" {
  return /^[A-Za-z]:\\/.test(p) || (p.includes("\\") && !p.includes("/")) ? "\\" : "/";
}

/** A planned item's row in Details: where it is on disk, and for a rename,
 *  where it is with the name the archive gives it, changing only the folders
 *  and file the rename changed. */
function entryRow(entry: PlannedEntry, renamed: boolean): Pick<ReportRow, "path" | "from"> {
  if (!renamed) return { path: entry.diskPath };
  const before = entry.originalPath.split("/");
  const after = entry.archivePath.split("/");
  const sep = separatorOf(entry.diskPath);
  const disk = entry.diskPath.split(sep);
  // Only a rename that keeps every segment can be laid on the disk path.
  if (before.length !== after.length || disk.length < after.length) return { path: entry.archivePath, from: entry.originalPath };
  const offset = disk.length - after.length;
  const shown = disk.map((segment, i) => i >= offset && before[i - offset] !== after[i - offset] ? after[i - offset]! : segment);
  return { path: shown.join(sep), from: entry.diskPath };
}

/** Where a path the archive's manifest traces to (an input's own name, then
 *  the path inside it) is on disk, from the job's inputs; the traced path
 *  itself when no input has that name. */
export function sourceOnDisk(source: string, inputs: readonly string[]): string {
  const [first = "", ...rest] = source.split("/");
  const input = inputs.find((p) => nameOf(p) === first);
  if (input === undefined) return source;
  const sep = separatorOf(input);
  return [input.replace(/[\\/]+$/, ""), ...rest].join(sep);
}

const LEVEL_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** The Details pane's cards for a job: one per kind of finding, one per reason
 *  something is left out, what a verification found, how the originals
 *  changed when a removal was refused, and the archive itself once made, the
 *  ones that block first. When the originals are to be removed, what is left
 *  out goes with them unarchived, which each excluded card says; anything but
 *  OS junk is then worth a look. */
export function detailsCards(
  job: Job,
  plan: PlanReport | null,
  verify: { missing: readonly string[]; extra: readonly string[] } | null,
  t: Translator,
  rowLimit: number,
): DetailsCard[] {
  const cards = new Map<string, DetailsCard & { excluded: boolean; junk: boolean }>();
  const card = (key: string, title: string, level: Severity, about?: MessageKey) => {
    let found = cards.get(key);
    if (!found) {
      found = { key, title, level, rows: [], names: [], open: false, excluded: false, junk: false, ...(about ? { about: t.t(about) } : {}) };
      cards.set(key, found);
    }
    return found;
  };
  if (plan) {
    const findingId = (f: Finding): string => `${f.rule}\0${f.path}\0${f.message}`;
    const onEntries = new Set<string>();
    for (const entry of plan.entries) {
      const dir = entry.type === "dir" ? { dir: true } : {};
      for (const f of entry.findings) {
        onEntries.add(findingId(f));
        const c = card(`rule:${f.rule}`, findingKind(f.rule, f.severity, t), f.severity, KIND_INFO[f.rule]);
        c.rows.push({ ...entryRow(entry, f.fix?.kind === "rename"), changes: [findingText(f, t, entry.excluded)], ...dir });
        // A duplicate is archived through another input, so it is not lost
        // with the originals (the SDK's `unarchived`).
        if (entry.excluded && entry.excludeCode !== "duplicate" && EXCLUDING_RULES.has(f.rule)) {
          c.excluded = true;
          c.junk = JUNK_RULES.has(f.rule);
        }
      }
      if (entry.excluded && !entry.findings.some((f) => EXCLUDING_RULES.has(f.rule))) {
        const reason = excludedText(entry, t);
        const c = card(`excluded:${reason}`, reason, "info", entry.excludeCode === "empty-dir" ? "kindInfo.emptyDirs" : undefined);
        c.rows.push({ path: entry.diskPath, changes: [reason], ...dir });
        c.excluded = entry.excludeCode !== "duplicate";
      }
    }
    for (const f of plan.findings) {
      if (onEntries.has(findingId(f))) continue;
      card(`rule:${f.rule}`, findingKind(f.rule, f.severity, t), f.severity, KIND_INFO[f.rule]).rows.push({ path: f.path, changes: [findingText(f, t)] });
    }
  }
  const pathRows = (paths: readonly string[]): ReportRow[] => paths.map((path) => ({ path, changes: [] }));
  // The originals by where they are, or were, on disk.
  const sourceRows = (paths: readonly string[]): ReportRow[] => pathRows(paths.map((p) => sourceOnDisk(p, job.inputs)));
  if (verify && verify.missing.length > 0) card("verify:missing", t.t("report.missing"), "error").rows.push(...pathRows(verify.missing));
  if (verify && verify.extra.length > 0) card("verify:extra", t.t("report.extra"), "warning").rows.push(...pathRows(verify.extra));
  // How the originals differ from the archive, a card per way, so each lists
  // names alone like every other card.
  const changes = job.originalsChanges;
  if (changes) {
    card("originals:missing", t.t("details.originalsMissing"), "error").rows.push(...sourceRows(changes.missing));
    card("originals:added", t.t("details.originalsAdded"), "error").rows.push(...sourceRows(changes.added));
    card("originals:changed", t.t("details.originalsModified"), "error").rows.push(...sourceRows(changes.changed));
    card("originals:unlisted", t.t("details.originalsUnreadable"), "error").rows.push(...sourceRows(changes.unlisted));
  }

  // What is left out leaves with the originals when they are removed.
  const removing = job.intent.originals !== "keep" && job.state !== "done" && job.state !== "failed";
  const result: DetailsCard[] = [];
  for (const { excluded, junk, ...c } of cards.values()) {
    if (c.rows.length === 0) continue;
    const shown: DetailsCard = { ...c, names: namesOf(c.rows, t.locale) };
    const texts = new Set(c.rows.map((row) => row.changes.join(" ")));
    const [only] = texts;
    if (texts.size === 1 && only) shown.common = only;
    if (c.key === "rule:output.exists") shown.countless = true;
    if (excluded && removing) {
      shown.note = t.t(job.intent.originals === "delete" ? "details.deletedUnarchived" : "details.trashedUnarchived");
      if (!junk && shown.level === "info") shown.level = "warning";
    }
    shown.open = shown.names.length <= rowLimit;
    result.push(shown);
  }

  const archive = archiveCard(job, t);
  if (archive) result.push(archive);
  // Most important first; within a level the archive leads, then the order found.
  const rank = (c: DetailsCard): number => LEVEL_RANK[c.level] * 2 + (c.key === "archive" ? 0 : 1);
  return result.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map(({ c }) => c);
}

/** The archive's size, with how much of the originals' size it takes when
 *  that is known (a job saved before ZipKit counted it has none). */
function archiveSize(bytes: number, sourceBytes: number | undefined, t: Translator): string {
  if (sourceBytes === undefined || sourceBytes <= 0) return t.size(bytes);
  const percent = new Intl.NumberFormat(t.locale, { style: "percent", maximumFractionDigits: 0 }).format(bytes / sourceBytes);
  return t.t("details.sizeOfOriginals", { size: { bytes }, percent, source: { bytes: sourceBytes } });
}

const ARCHIVE_STATUS_KEYS: Record<NonNullable<Job["archiveStatus"]>, MessageKey> = {
  written: "details.statusWritten",
  verified: "details.statusVerified",
  changed: "details.statusChanged",
  missing: "details.statusMissing",
  unavailable: "details.statusUnavailable",
};

/** The archive a job made, as facts: what ZipKit knows of it now, where it is,
 *  how large, what it holds. Absent until there is one. */
function archiveCard(job: Job, t: Translator): DetailsCard | null {
  if (!job.archiveStatus || !job.output) return null;
  const facts: Array<{ label: string; value: string }> = [
    { label: t.t("details.factStatus"), value: t.t(ARCHIVE_STATUS_KEYS[job.archiveStatus]) },
    { label: t.t("details.factPath"), value: job.output },
  ];
  if (job.archiveBytes !== undefined) facts.push({ label: t.t("details.factSize"), value: archiveSize(job.archiveBytes, job.summary?.sourceBytes, t) });
  if (job.summary) facts.push({ label: t.t("details.factEntries"), value: t.number(job.summary.included) });
  facts.push({
    label: t.t("details.factManifest"),
    value: job.options.metadata
      ? (job.options.hash ? t.t("details.manifestWithHash", { file: "zipkit.json" }) : "zipkit.json")
      : t.t("details.manifestNone"),
  });
  if (job.summary?.zip64) facts.push({ label: t.t("details.factFormat"), value: "Zip64" });
  const level: Severity = job.archiveStatus === "missing"
    ? "error"
    : job.archiveStatus === "changed" || job.archiveStatus === "unavailable" ? "warning" : "info";
  return { key: "archive", title: t.t("details.archive"), level, rows: [], names: [], open: true, countless: true, facts };
}

/** A path's last segment: the name a card shows for it. */
export function nameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

function collator(locale: string): Intl.Collator {
  return new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
}

/** The names of a card's rows, each once with how many rows carry it, in the
 *  order the locale sorts names: a card shows names only, so every
 *  `.DS_Store` reads as one line however many folders held one. A renamed
 *  item goes by the name it has on disk, the one the user would look for. */
export function namesOf(rows: readonly ReportRow[], locale: string): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const name = nameOf(row.from ?? row.path);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const order = collator(locale);
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => order.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Every row by its full path, in the order the locale sorts them, so a
 *  folder's rows read together. */
export function rowsByPath(rows: readonly ReportRow[], locale: string): ReportRow[] {
  const order = collator(locale);
  return [...rows].sort((a, b) => order.compare(a.path, b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
