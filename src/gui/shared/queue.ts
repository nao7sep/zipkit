/**
 * The job/queue model shared between the main-process queue engine and the
 * renderer's list+detail view. A `Job` is the list-item view — enough to render
 * the row and the verdict, but not the heavy per-entry plan data, which the
 * renderer fetches for the selected job via `getPlan`.
 */

import type { PlanSummary } from "../../sdk/types.js";
import type { GuiOptions } from "./spec.js";

/** What a job does when run: just write, or write-verify-then-Trash the originals. */
export type JobIntent = "save" | "archive-and-trash";

/**
 * What an input path is on disk, for the GUI's job-management UX (the label, the
 * input list, gating "move originals to Trash"). This is filesystem plumbing —
 * how a job is assembled — not ZIP-codec concern, so it lives GUI-side, not in
 * the SDK. The union is intentionally open to extension (e.g. "symlink") later.
 */
export type PathKind = "directory" | "file" | "nonexistent" | "other";

/** An input path classified by what it currently is on disk. */
export interface InputEntry {
  path: string;
  kind: PathKind;
}

/**
 * - `planning` — being (re)planned.
 * - `needs-attention` — planned but not writable (a blocking finding); can't run.
 * - `ready` — writable, not yet asked to run.
 * - `queued` — asked to run while another job is running; waiting its turn. (A job
 *   asked to run while the engine is idle goes straight to `running`, never through
 *   `queued` — the state appears only when there is a real wait.)
 * - `running` — being written (and, for the destructive intent, verified + trashed).
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

export interface Job {
  id: string;
  inputs: string[];
  /** `inputs` classified on disk (dir/file/nonexistent), kept in step with
   *  `inputs` by the engine. Absent only in the brief window before the first
   *  classification resolves. */
  entries?: InputEntry[];
  options: GuiOptions;
  intent: JobIntent;
  state: JobState;
  /** Resolved output path (once planned). */
  output?: string;
  summary?: PlanSummary;
  writable?: boolean;
  /** A short status line for needs-attention / failed / done. */
  message?: string;
  /** The SDK error code (e.g. `output.ambiguous`) when a fault produced the
   *  current state, so the renderer can show stable, friendly guidance keyed on
   *  the code rather than parsing `message`. Absent when there is no fault. */
  errorCode?: string;
}

/** The resumable part of a job that survives a restart (no transient run state). */
export interface SavedJob {
  id: string;
  inputs: string[];
  options: GuiOptions;
  intent: JobIntent;
}
