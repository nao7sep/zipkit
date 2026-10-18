/**
 * The contextBridge surface the GUI exposes to the renderer as `window.zipkit`.
 *
 * An explicit interface in `shared` — not `typeof api` from preload — so the
 * renderer references the type without importing preload (whose `electron` import
 * would drag Node types into the renderer program). Preload implements it via
 * `satisfies ZipKitGuiApi`. SDK types come from `zipkit/types` (pure data, no
 * runtime, no Node) via `import type`.
 *
 * The renderer never plans or writes directly: it manages a queue of jobs (the
 * main process runs each job's plan/write/verify/trash) and subscribes to the
 * job-list and event streams. The full plan for the selected job is fetched on
 * demand for the detail view, so heavy per-entry data is never pushed for every
 * job in the list.
 */

import type { InputAdmission } from "./input-admission.js";
import type { ArchiveSpec, ExtractData, Finding, LogEvent, PlanData, PlannedEntry, PlanSummary, ProgressCounts, Severity, SourceComparison } from "zipkitsdk/types";
import type { PlanReport } from "./plan-report.js";
import type { GuiOptions, GuiSettings } from "./spec.js";
import type { InputEntry, Job, JobIntent, PathKind } from "./queue.js";
import type { PaneLayout } from "./layout.js";
import type { Language, LanguageEnvironment } from "./i18n/languages.js";
import type { Message } from "./i18n/translate.js";
import type { RecordDetail, RecordKind, RecordSources, RecordsPage, RecordsQuery } from "./records.js";


/** The host OS, as a portable literal union — mirrors `process.platform` without
 *  pulling Node's `NodeJS` namespace into the renderer program. */
export type GuiPlatform =
  | "aix"
  | "android"
  | "darwin"
  | "freebsd"
  | "haiku"
  | "linux"
  | "openbsd"
  | "sunos"
  | "win32"
  | "cygwin"
  | "netbsd";

export type { ArchiveSpec, PlanData, ExtractData, Finding, PlannedEntry, PlanReport, PlanSummary, InputEntry, Job, JobIntent, LogEvent, PathKind, ProgressCounts, Severity, SourceComparison };
export type { LanguageEnvironment, Message, PaneLayout };

/** The action that started a Progress run: a background plan, Create (its
 *  fresh plan, write, verify and Trash), Verify, or moving a finished job's
 *  originals to Trash. */
export type JobAction = "plan" | "create" | "verify" | "trash" | "delete";

/** An SDK progress event under the job it ran for, as main records it in
 *  `records.sqlite3` and sends it to the window. `session` (the launch's start)
 *  and `seq` (its order in that launch) identify it, so a recorded copy and the
 *  live one are recognised as the same event. `action` and `run` name the run
 *  it belongs to: every event one action caused shares one run id. */
export interface JobEvent {
  jobId: string;
  session: string;
  seq: number;
  action: JobAction;
  run: string;
  event: LogEvent;
}

/** How far a job's current write or verification has got; null once a step
 *  that reports no counts begins. Live only, never recorded. */
export interface JobCounts {
  jobId: string;
  counts: ProgressCounts | null;
}

/** How many of a job's newest events its Progress pane holds. */
export const JOB_EVENT_LIMIT = 2000;

/** A structured SDK fault surfaced to the renderer. `presentation` is authored
 * by main as a catalogue message; arbitrary exception prose has no field on
 * this boundary. */
export interface GuiError {
  /** The SDK error's kind (`internal` for a failure the SDK did not classify). */
  kind: string;
  code: string;
  presentation: Message;
}

/** A renderer-side exception serialized before it crosses contextBridge. */
export interface GuiReportedError {
  name: string;
  message: string;
  stack?: string;
  cause?: GuiReportedError;
}

/** What a verification tells the window: the verdict, the counts and the paths
 *  the archive and its manifest disagree on, never every entry's result. */
export type VerifyReport = Pick<ExtractData, "reportOk" | "summary" | "missing" | "extra">;
export type VerifyResult = { ok: true; data: VerifyReport } | { ok: false; error: GuiError };

/** What each System choice in Settings resolves to now (app-chrome and
 *  timestamp conventions): the OS appearance, the computer's language and its zone. */
export interface SystemChoices {
  appearance: "light" | "dark";
  language: Language;
  timeZone: string;
}

/** App identity for the About dialog (the renderer can't read package.json). */
export interface AppInfo {
  name: string;
  version: string;
}

/** Main-to-renderer native BrowserWindow activation event. */
export const WINDOW_ACTIVITY_CHANNEL = "zipkit:windowActivity";

/** Main-to-renderer event: the app menu asked for the About dialog. */
export const OPEN_ABOUT_CHANNEL = "zipkit:openAbout";

/** Main-to-renderer event: a saved language choice moved the interface language. */
export const LANGUAGE_CHANGED_CHANNEL = "zipkit:languageChanged";

/** Main-to-renderer event: the records database stored a record. */
export const RECORDS_CHANGED_CHANNEL = "zipkit:recordsChanged";

export interface ZipKitGuiApi {
  /** Open a native picker; returns chosen absolute paths (empty if cancelled). */
  chooseInputs(): Promise<string[]>;
  /** Open a native directory picker; returns the chosen absolute dir ("" if cancelled). */
  chooseOutputDir(): Promise<string>;
  /** The absolute path for a drag-dropped File (Electron's webUtils route). */
  pathForFile(file: File): string;
  /** The host OS platform (`process.platform`), so the renderer can show the
   *  running platform's modifier word — "Cmd" on macOS, "Ctrl" elsewhere. */
  platform: GuiPlatform;
  /** Native window activation, distinct from DOM document focus on macOS. */
  onWindowActivityChanged(callback: (active: boolean) => void): () => void;

  /** The interface language main settled on, and the locale its dates and
   *  numbers are formatted in. */
  getLanguageEnvironment(): Promise<LanguageEnvironment>;
  /** Follow a saved language change; returns an unsubscribe function. */
  onLanguageChanged(callback: (environment: LanguageEnvironment) => void): () => void;
  /** Follow the app menu's About command; returns an unsubscribe function. */
  onOpenAbout(callback: () => void): () => void;
  /** What each System choice resolves to now, for the Settings labels. */
  getSystemChoices(): Promise<SystemChoices>;

  /** The persisted GUI settings — new-job defaults plus the UI font (built-in defaults if none saved). */
  getSettings(): Promise<GuiSettings>;
  /** Committed preferences, including a save retried by the quit owner. */
  onSettingsChanged(callback: (settings: GuiSettings) => void): () => void;
  /** Retire a failed submission after explicit discard; rejects while saving. */
  discardSettingsSubmission(): Promise<void>;
  /** Tells main whether the Settings dialog holds edits not yet submitted, so
   *  quit can ask before discarding them. */
  reportSettingsDraft(dirty: boolean): void;
  /** Persist the dialog's settings and return the effective settings; rejects on failure. */
  setSettings(settings: GuiSettings): Promise<GuiSettings>;

  /** The persisted pane layout (the default layout if none saved). */
  getLayout(): Promise<PaneLayout>;
  /** Persist the pane layout; rejects so the renderer can retain and present a failed save. */
  setLayout(layout: PaneLayout): Promise<void>;

  /** Enqueue a job (planned in the background); returns its id. Non-blocking — it
   *  never waits on a running write. */
  /** A new job verifies and keeps its originals until the user chooses otherwise. */
  addJob(inputs: string[], options: GuiOptions): Promise<string>;
  /** Change an editable job's options or intent; plan-affecting options re-plan. */
  updateJob(
    id: string,
    patch: { options?: GuiOptions; intent?: JobIntent },
  ): Promise<void>;
  /** Apply inputs against the current job, independent of renderer projections. */
  addJobInputs(id: string, paths: string[]): Promise<InputAdmission>;
  removeJobInput(id: string, path: string): Promise<void>;
  /** Remove a queued job (no effect while it is running). */
  removeJob(id: string): Promise<void>;
  /** Create one job's archive now (or retry a failed one); the engine serializes. */
  runJob(id: string, scope: { intent: JobIntent; inputs: string[] }): Promise<void>;
  /** Trash a finished `save` job's archive and return it to an editable state. */
  removeArchive(id: string): Promise<void>;
  /** Move a finished `save` job's originals to Trash on explicit request. */
  trashOriginals(id: string): Promise<void>;
  deleteOriginals(id: string): Promise<void>;
  /** Cancel a job's in-flight plan or write. */
  cancelJob(id: string): Promise<void>;
  /** The full plan for a job's detail view, or null if it has none right now. */
  /** The selected job's plan as the report shows it: only the entries it lists. */
  getPlan(id: string): Promise<PlanReport | null>;
  /** The current job list — the initial fetch on mount; `onQueue` pushes updates. */
  getQueue(): Promise<Job[]>;
  /** Subscribe to the job list; returns an unsubscribe function. */
  onQueue(callback: (jobs: Job[]) => void): () => void;
  /** Follow whether the latest queue save succeeded; returns an unsubscribe function. */
  onQueueSaved(callback: (saved: boolean) => void): () => void;

  /** Verify a finished job's archive in full (CRC-32 for every entry, and the
   *  manifest when the job embedded one); main records the outcome in the job.
   *  Null when there was nothing to verify, such as an archive found gone. The
   *  job id tags the verify's progress events to that job's Progress stream. */
  verify(jobId: string): Promise<VerifyResult | null>;
  /** Look at a job's originals again, and a finished job's archive: main notes
   *  an original gone or out of reach, and an archive changed, replaced, gone
   *  or out of reach. */
  refreshJob(jobId: string): Promise<void>;
  /** Reveal a file in the OS file manager (Finder / Explorer). */
  reveal(path: string): Promise<void>;
  /** A job's recorded progress events, oldest first, from this and earlier
   *  launches. */
  getJobEvents(jobId: string): Promise<JobEvent[]>;
  /** Subscribe to the live progress events of every job; returns an unsubscribe fn. */
  onEvents(callback: (events: JobEvent[]) => void): () => void;
  /** Subscribe to how far each job's write or verification has got. */
  onProgress(callback: (counts: JobCounts[]) => void): () => void;

  /** Open the Records window, or bring it forward when it is open. */
  openRecordsWindow(): Promise<void>;
  /** One page of record summaries, newest first. */
  readRecordsPage(query: RecordsQuery): Promise<RecordsPage>;
  /** One record whole, or null when it is not there. */
  readRecordDetail(kind: RecordKind, id: number): Promise<RecordDetail | null>;
  /** The launches the records hold, and this one. */
  readRecordSources(): Promise<RecordSources>;
  /** The Records window's list pane width: the dragged intent. */
  getRecordsListWidth(): Promise<number>;
  /** Persist the list pane width after a drag; returns the width stored. */
  saveRecordsListWidth(width: number): Promise<number>;
  /** Follow the records database storing a record; returns an unsubscribe fn. */
  onRecordsChanged(callback: () => void): () => void;

  /** App name + version for the About dialog. */
  appInfo(): Promise<AppInfo>;
  /** Open an http(s) URL in the OS browser (never navigates the renderer window). */
  openExternal(url: string): Promise<void>;
  /** Preserve an unexpected renderer-side failure in the main-process session log. */
  reportError(context: string, error: GuiReportedError): void;
}
