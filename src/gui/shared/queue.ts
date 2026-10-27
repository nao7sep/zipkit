/**
 * The job/queue model shared between the main-process queue engine and the
 * renderer's list+detail view. A `Job` is the list-item view — enough to render
 * the row and the verdict, but not the heavy per-entry plan data, which the
 * renderer fetches for the selected job via `getPlan`.
 */

import type { PathEntry, PathKind as SdkPathKind, PlanSummary, Severity } from "zipkitsdk/types";
import type { GuiOptions } from "./spec.js";
import type { Message } from "./i18n/translate.js";

/** What happens to the originals once the archive is created and verified. */
export type OriginalsAction = "keep" | "trash" | "delete";

/** How a job runs once its archive is written: whether it verifies the archive,
 *  and what happens to the originals. Transient, like a dialog's choice: never
 *  saved with the job or as a default, and every new or restored job starts at
 *  the safest choice. */
export interface JobIntent {
  verify: boolean;
  originals: OriginalsAction;
}

/** Verify, and keep the originals. */
export const SAFEST_INTENT: JobIntent = { verify: true, originals: "keep" };

/** Whether the run moves the originals to Trash or deletes them. */
export function removesOriginals(intent: JobIntent): boolean {
  return intent.originals !== "keep";
}

/** Removing the originals always verifies the archive first, whatever the box says. */
export function verifies(intent: JobIntent): boolean {
  return intent.verify || removesOriginals(intent);
}

export function sameIntent(a: JobIntent, b: JobIntent): boolean {
  return a.verify === b.verify && a.originals === b.originals;
}

/** What an input is on disk, and an input with it: the SDK's own `PathKind`
 *  and `PathEntry` (see `ZipKit.pathKinds`). `unavailable` is out of reach, never
 *  gone: its drive is not connected or it cannot be read, so nothing is decided
 *  on it. */
export type PathKind = SdkPathKind;
export type InputEntry = PathEntry;

/**
 * - `planning` — being (re)planned.
 * - `needs-attention` — planned but not writable (a blocking finding); can't run.
 * - `ready` — writable, not yet asked to run.
 * - `queued` — asked to run while another job is running; waiting its turn. (A job
 *   asked to run while the engine is idle goes straight to `running`, never through
 *   `queued` — the state appears only when there is a real wait.)
 * - `running` — being written, then verified, and its originals removed when chosen.
 * - `done` / `failed` — terminal.
 */
export type JobState =
  | "planning"
  | "needs-attention"
  | "ready"
  | "queued"
  | "running"
  | "done"
  | "failed";

/** A job's options/intent/inputs may be edited only before it runs and while not
 *  done. A `queued` job is committed to run (waiting its turn), so it is locked
 *  too — cancelling it returns it to an editable `ready`/`needs-attention` state.
 *  A failed job whose archive was written is locked like a done one: that
 *  archive is the record of its options, and Retry resumes from it; moving the
 *  archive to Trash unlocks the job. It lives here, beside the states, because
 *  the engine and the renderer must lock the same set: the controls the
 *  renderer disables are exactly the writes the engine refuses, and a second
 *  spelling of the rule is what let a finished job keep taking writes. */
export function isEditable(job: Pick<Job, "state" | "archiveWritten">): boolean {
  if (job.state === "failed") return job.archiveWritten !== true;
  return job.state !== "running" && job.state !== "done" && job.state !== "queued";
}

/** Whether every input is still on disk, as last classified (unknown counts as
 *  there). Moving the archive to Trash is offered only then, since its
 *  confirmation promises the originals are kept; one rule for both sides. */
export function originalsIntact(job: Pick<Job, "entries">): boolean {
  return job.entries?.every((entry) => entry.kind !== "missing" && entry.kind !== "unavailable") ?? true;
}

/** Whether an input is on disk now, as last classified. */
export function present(entry: InputEntry): boolean {
  return entry.kind === "directory" || entry.kind === "file" || entry.kind === "other";
}

/** A job that removes its originals verifies the archive against its manifest
 *  before it moves or deletes anything, so it cannot run with the manifest
 *  turned off. One copy, so the engine refuses exactly the runs the renderer
 *  does not offer. */
export function manifestRequiredButMissing(intent: JobIntent, manifest: boolean): boolean {
  return removesOriginals(intent) && !manifest;
}

/** A job that removes its originals, whose plan found a folder it could not
 *  list: that folder's contents are in neither the archive nor its manifest, so
 *  no check could show the originals are safe to remove. */
export function scanBlocksRemoval(job: Pick<Job, "intent" | "scanIncomplete">): boolean {
  return removesOriginals(job.intent) && job.scanIncomplete === true;
}

/** What ZipKit last found of the archive a job wrote: as written, verified and
 *  unchanged since, changed since it was written or verified, gone or replaced
 *  by another file (missing), or out of reach on a drive that is not connected. */
export type ArchiveStatus = "written" | "verified" | "changed" | "missing" | "unavailable";

/** One thing that happened to a job, in the order it happened: a run's
 *  outcome, a verification, an archive found missing, the originals removed. */
export interface JobHistoryEntry {
  at: number;
  severity: Severity;
  message: Message;
}

export interface Job {
  id: string;
  inputs: string[];
  /** `inputs` classified on disk (dir/file/missing), kept in step with
   *  `inputs` by the engine. Absent only in the brief window before the first
   *  classification resolves. */
  entries?: InputEntry[];
  options: GuiOptions;
  intent: JobIntent;
  state: JobState;
  /** Resolved output path (once planned). */
  output?: string;
  summary?: PlanSummary;
  /** Counts this job's plans: it changes only when a new plan replaces the
   *  last, so the selected Report is read again only then. */
  planRevision?: number;
  writable?: boolean;
  /** A short status line for needs-attention / failed / done, as a catalogue
   *  message so it renders in the interface language current when shown. */
  message?: Message;
  /** Result of a follow-up action performed on a terminal job, such as moving
   * the archive or originals to Trash. Kept separate from lifecycle `message`
   * so its severity and recovery are explicit rather than parsed from prose. */
  actionResult?: { severity: Severity; message: Message };
  /** The SDK error code (e.g. `output.ambiguous`) when a fault produced the
   *  current state, so the renderer can show stable, friendly guidance keyed on
   *  the code rather than parsing `message`. Absent when there is no fault. */
  errorCode?: string;
  /** Whether the held plan found a folder it could not list (an
   *  `entry.unlisted` warning): its contents are missing from the archive. */
  scanIncomplete?: boolean;
  /** Whether this job's latest run wrote its archive (the file may still need
   *  checking, but it is there to reveal or move to Trash). */
  archiveWritten?: boolean;
  /** Changes whenever the observed archive identity or availability changes. */
  archiveRevision?: number;
  /** The archive's state as last checked, while the job has one, or "missing"
   *  once it is gone and the job cannot simply create it again. */
  archiveStatus?: ArchiveStatus;
  /** What has happened to this job so far in this session, oldest first. */
  history?: JobHistoryEntry[];
  /** The archive's size in bytes, once written. */
  archiveBytes?: number;
  /** How the originals differed from the archive when a removal was refused
   *  because they changed: the paths, as the archive names them. */
  originalsChanges?: { missing: string[]; added: string[]; changed: string[]; unlisted: string[] };
  /** Set while a finished job's originals are being checked and moved to
   *  Trash or deleted on request, or its archive moved to Trash: the job is
   *  busy, and only Cancel is offered. */
  trashing?: boolean;
}

/** The resumable part of a job that survives a restart: no transient run
 *  state, and no intent, which every restored job takes as {@link SAFEST_INTENT}. */
export interface SavedJob {
  id: string;
  inputs: string[];
  options: GuiOptions;
}
