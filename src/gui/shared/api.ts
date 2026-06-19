/**
 * The contextBridge surface the GUI exposes to the renderer as `window.zipkit`.
 *
 * An explicit interface in `shared` — not `typeof api` from preload — so the
 * renderer references the type without importing preload (whose `electron` import
 * would drag Node types into the renderer program). Preload implements it via
 * `satisfies ZipKitGuiApi`. SDK types come from `src/sdk/types` (pure data, no
 * runtime, no Node) via `import type`.
 *
 * The renderer never plans or writes directly: it manages a queue of jobs (the
 * main process runs each job's plan/write/verify/trash) and subscribes to the
 * job-list and event streams. The full plan for the selected job is fetched on
 * demand for the detail view, so heavy per-entry data is never pushed for every
 * job in the list.
 */

import type { ArchiveSpec, CreateData, ExtractData, Finding, LogEvent, Severity } from "../../sdk/types.js";
import type { GuiOptions } from "./spec.js";
import type { InputEntry, Job, JobIntent, PathKind } from "./queue.js";
import type { PaneLayout } from "./layout.js";

/** The `mode:"plan"` payload — the dry run shown in a job's detail. */
export type PlanData = Extract<CreateData, { mode: "plan" }>;

export type { ArchiveSpec, ExtractData, Finding, InputEntry, Job, JobIntent, LogEvent, PathKind, Severity };
export type { PaneLayout };

/** An SDK progress event tagged with the job it belongs to, so the renderer can
 *  show each job its own activity stream. `jobId` is absent for any untagged event. */
export type GuiLogEvent = LogEvent & { jobId?: string };

/** A structured SDK fault surfaced to the renderer (mirrors `ZipKitError`'s shape). */
export interface GuiError {
  type: string;
  code: string;
  message: string;
}

export type VerifyResult = { ok: true; data: ExtractData } | { ok: false; error: GuiError };

/** App identity for the About dialog (the renderer can't read package.json). */
export interface AppInfo {
  name: string;
  version: string;
}

export interface ZipKitGuiApi {
  /** Open a native picker; returns chosen absolute paths (empty if cancelled). */
  chooseInputs(): Promise<string[]>;
  /** Open a native folder picker; returns the chosen absolute dir ("" if cancelled). */
  chooseOutputDir(): Promise<string>;

  /** The persisted defaults for new jobs (the built-in defaults if none saved). */
  getSettings(): Promise<GuiOptions>;
  /** Persist the defaults for new jobs (best-effort; never rejects). */
  setSettings(defaults: GuiOptions): Promise<void>;

  /** The persisted pane layout (the default layout if none saved). */
  getLayout(): Promise<PaneLayout>;
  /** Persist the pane layout (best-effort; never rejects). */
  setLayout(layout: PaneLayout): Promise<void>;

  /** Enqueue a job (planned in the background); returns its id. Non-blocking — it
   *  never waits on a running write. */
  addJob(inputs: string[], options: GuiOptions, intent: JobIntent): Promise<string>;
  /** Change a queued job's options, intent, and/or inputs (re-plans + re-classifies
   *  on an options/inputs change). */
  updateJob(
    id: string,
    patch: { options?: GuiOptions; intent?: JobIntent; inputs?: string[] },
  ): Promise<void>;
  /** Remove a queued job (no effect while it is running). */
  removeJob(id: string): Promise<void>;
  /** Create one job's archive now (or retry a failed one); the engine serializes. */
  runJob(id: string): Promise<void>;
  /** Trash a finished `save` job's archive and return it to an editable state. */
  removeArchive(id: string): Promise<void>;
  /** Move a finished `save` job's originals to Trash on explicit request. */
  trashOriginals(id: string): Promise<void>;
  /** Cancel a job's in-flight plan or write. */
  cancelJob(id: string): Promise<void>;
  /** The full plan for a job's detail view, or null if it has none right now. */
  getPlan(id: string): Promise<PlanData | null>;
  /** The current job list — the initial fetch on mount; `onQueue` pushes updates. */
  getQueue(): Promise<Job[]>;
  /** Subscribe to the job list; returns an unsubscribe function. */
  onQueue(callback: (jobs: Job[]) => void): () => void;

  /** Verify a job's archive on demand: CRC always, plus manifest + SHA when set.
   *  The job id tags the verify's progress events to that job's activity stream. */
  verify(jobId: string, archive: string, checkMetadata: boolean): Promise<VerifyResult>;
  /** Reveal a file in the OS file manager (Finder / Explorer). */
  reveal(path: string): void;
  /** Subscribe to the live, job-tagged SDK event stream; returns an unsubscribe fn. */
  onEvent(callback: (event: GuiLogEvent) => void): () => void;

  /** App name + version for the About dialog. */
  appInfo(): Promise<AppInfo>;
  /** Open an http(s) URL in the OS browser (never navigates the renderer window). */
  openExternal(url: string): void;
}
