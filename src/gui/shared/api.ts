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
import type { Job, JobIntent } from "./queue.js";

/** The `mode:"plan"` payload — the dry run shown in a job's detail. */
export type PlanData = Extract<CreateData, { mode: "plan" }>;

export type { ArchiveSpec, ExtractData, Finding, Job, JobIntent, LogEvent, Severity };

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

  /** Enqueue a job (planned in the background); returns its id. Non-blocking — it
   *  never waits on a running write. */
  addJob(inputs: string[], options: GuiOptions, intent: JobIntent): Promise<string>;
  /** Change a queued job's options and/or intent (re-plans on an options change). */
  updateJob(id: string, patch: { options?: GuiOptions; intent?: JobIntent }): Promise<void>;
  /** Remove a queued job (no effect while it is running). */
  removeJob(id: string): Promise<void>;
  /** Start draining the ready jobs sequentially (one write at a time). */
  startQueue(): Promise<void>;
  /** Cancel a job's in-flight plan or write. */
  cancelJob(id: string): Promise<void>;
  /** The full plan for a job's detail view, or null if it has none right now. */
  getPlan(id: string): Promise<PlanData | null>;
  /** The current job list — the initial fetch on mount; `onQueue` pushes updates. */
  getQueue(): Promise<Job[]>;
  /** Subscribe to the job list; returns an unsubscribe function. */
  onQueue(callback: (jobs: Job[]) => void): () => void;

  /** Verify an archive on demand: CRC always, plus manifest + SHA when set. */
  verify(archive: string, checkMetadata: boolean): Promise<VerifyResult>;
  /** Subscribe to the live SDK event stream; returns an unsubscribe function. */
  onEvent(callback: (event: LogEvent) => void): () => void;

  /** App name + version for the About dialog. */
  appInfo(): Promise<AppInfo>;
  /** Open an http(s) URL in the OS browser (never navigates the renderer window). */
  openExternal(url: string): void;
}
