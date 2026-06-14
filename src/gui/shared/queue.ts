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
 * - `planning` — being (re)planned.
 * - `needs-attention` — planned but not writable (a blocking finding); can't run.
 * - `ready` — writable, waiting its turn.
 * - `running` — being written (and, for the destructive intent, verified + trashed).
 * - `done` / `failed` — terminal.
 */
export type JobState = "planning" | "needs-attention" | "ready" | "running" | "done" | "failed";

export interface Job {
  id: string;
  inputs: string[];
  options: GuiOptions;
  intent: JobIntent;
  state: JobState;
  /** Resolved output path (once planned). */
  output?: string;
  summary?: PlanSummary;
  writable?: boolean;
  /** A short status line for needs-attention / failed / done. */
  message?: string;
}
