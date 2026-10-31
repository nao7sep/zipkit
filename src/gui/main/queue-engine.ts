/**
 * The queue engine: the job records and the state machine that drives them.
 * Plans each job in the background on add, alongside whatever else runs; a
 * newer plan supersedes an older one through its AbortController. Everything
 * that reads or changes an archive or the originals is an effect, and effects
 * run one at a time in request order: Create (write, then verify when chosen,
 * then, when the originals are to leave, every check and a per-item Trash or
 * permanent deletion), moving a finished job's archive or originals to Trash
 * or deleting them, Verify and Refresh. A Create on a job still being planned
 * waits for that plan. Because no two effects overlap, no path needs claiming:
 * the order is the guarantee. Effects take turns for correctness, not speed:
 * jobs can share originals and output folders, and compressing on one core
 * would otherwise leave room for more (developer decision). Partial outcomes
 * are reported exactly; one job failing never blocks the rest.
 *
 * This is GUI-side orchestration — when to call which capability — not archive
 * logic: every verdict it acts on (`writable`, the verify result) comes from the
 * SDK. The SDK, OS Trash, persistence, event forwarding, and id minting arrive as
 * injected deps, so the engine is Electron-free and unit-testable with fakes. SDK
 * progress events are tagged with the originating job's id and the run of the
 * action that caused them before they are forwarded, so the renderer can show
 * each job its own Progress, headed by action.
 */

import { planInputAdmission, type InputAdmission } from "../shared/input-admission.js";
import {
  isEditable,
  manifestRequiredButMissing,
  originalsIntact,
  removesOriginals,
  SAFEST_INTENT,
  sameIntent,
  scanBlocksRemoval,
  type InputEntry,
  type Job,
  type JobState,
  type ArchiveStatus,
  type JobHistoryEntry,
  type JobIntent,
  type OriginalsAction,
  present,
  type SavedJob,
} from "../shared/queue.js";
import type { JobAction, LogEvent, PlanData, VerifyReport } from "../shared/api.js";
import { COMPRESSION_LEVEL_RANGE, isWholeNumberIn, optionsEqual, planAffectingChanged, type GuiOptions } from "../shared/spec.js";
import { errorInfo, type AppLog } from "./log.js";
import { reportChanged } from "./plan-review.js";
import { describeOriginalsRemoval, describeRemovalDone, trashConfirmed, type TrashResult } from "./trash-outcome.js";
import { message, sentences, type Message } from "../shared/i18n/translate.js";
import type { MessageKey } from "../shared/i18n/catalogues.js";
import type { CommandAdmission } from "./command-admission.js";
import { isZipKitError, sameFile, type PathState, type RemovalRefusal, type RemovalResult } from "zipkitsdk";

export type { TrashResult } from "./trash-outcome.js";

export interface EngineDeps {
  admission: CommandAdmission;
  /** What is at a path now: there with a comparable fingerprint (which file,
   *  its size and when it last changed), missing, or out of reach. */
  pathState(target: string, signal: AbortSignal): Promise<PathState>;
  /** Dry-run plan for the given inputs/options; progress events go to `onEvent`. */
  plan(inputs: string[], options: GuiOptions, signal: AbortSignal, onEvent: (e: LogEvent) => void): Promise<PlanData>;
  /** Write a planned archive; resolves to the byte count, or null when the SDK
   *  refused because an output appeared at the path since the plan. */
  write(plan: PlanData, signal: AbortSignal, onEvent: (e: LogEvent) => void): Promise<number | null>;
  /** Verify a written archive: every entry's CRC-32, and against the manifest
   *  named, when one is; resolves to the SDK's verdict. */
  verify(output: string, signal: AbortSignal, onEvent: (e: LogEvent) => void, manifestName: string | null): Promise<boolean>;
  /** Verify a written archive on request: the verdict, the counts and the
   *  paths that disagree, for the job's review. */
  inspect(output: string, signal: AbortSignal, onEvent: (e: LogEvent) => void, manifestName: string | null): Promise<VerifyReport>;
  /** Remove the originals `inputs` by `method` after every check (the SDK's
   *  removeOriginals): the archive is not inside them, it verifies against its
   *  manifest, and a fresh scan of `inputs` under the job's options still
   *  matches it; `removed` are inputs already gone. A cancel during the checks
   *  is thrown; once removal began, the inputs not yet started are kept. */
  removeOriginals(
    output: string,
    inputs: string[],
    removed: string[],
    options: GuiOptions,
    method: RemovalMethod,
    signal: AbortSignal,
    onEvent: (e: LogEvent) => void,
  ): Promise<AppRemoval>;
  /** Classify input paths on disk (dir/file/missing) for the job's `entries`. */
  pathKinds(paths: string[], signal?: AbortSignal): Promise<InputEntry[]>;
  /** Move each path in turn to the OS Trash and report the exact outcome, for
   *  the archive. A path not yet started when `signal` aborts is reported in
   *  `failed` (kept); a call already running ends first. */
  trash(paths: string[], signal: AbortSignal): Promise<TrashResult>;
  /** Push the current job list to observers (renderer + persistence). */
  emit(jobs: Job[]): void;
  /** Start a Progress run for a job's action: every event the returned sink
   *  receives is recorded under that run and forwarded to the renderer. */
  progress(jobId: string, action: JobAction): (event: LogEvent) => void;
  /** Mint a job id. */
  newId(): string;
  /** The app session log — one line per orchestration intent/outcome. */
  log: AppLog;
}

export interface RunScope { intent: JobIntent; inputs: string[] }
/** How the originals leave: to the recoverable Trash, or deleted permanently. */
export type RemovalMethod = Exclude<OriginalsAction, "keep">;
export interface QueueEngine {
  snapshot(): Job[];
  /** A new job verifies and keeps its originals until the user chooses otherwise. */
  add(inputs: string[], options: GuiOptions, intent?: JobIntent): string;
  update(id: string, patch: { options?: GuiOptions; intent?: JobIntent }): void;
  addInputs(id: string, paths: string[]): InputAdmission;
  removeInput(id: string, path: string): void;
  remove(id: string): void;
  cancel(id: string): void;
  /** Request that a specific job's archive be created (or a failed one retried). */
  run(id: string, scope: RunScope): void;
  /** Trash a finished job's archive while its originals remain, and return it to an editable state. */
  removeArchive(id: string): void;
  /** Move a finished job's originals to Trash, or delete them permanently, on
   *  explicit, deliberate request, after the same checks a run makes. */
  removeOriginals(id: string, method: RemovalMethod): void;
  /** Verify a finished job's archive on request, in its turn, and record the
   *  outcome. Throws when it could not be verified at all; the job's history
   *  says why. */
  verify(id: string): Promise<VerifyReport | null>;
  /** Look at a job's originals again, and a finished job's archive, in its
   *  turn: note an original gone or out of reach, an archive changed, replaced
   *  or gone. */
  refresh(id: string): Promise<void>;
  getPlan(id: string): PlanData | null;
  restore(saved: SavedJob[]): void;
  /** True while an effect runs on a job (not merely queued). */
  hasRunningJob(): boolean;
  /** For app quit: cancel the running effect, drop the queued ones, stop every
   *  plan and look at the inputs, and resolve only once all of it has actually
   *  stopped, so quit can wait for the writer's own `abort()` to remove its temp
   *  file and no file call is left running at exit. Edits stay accepted until
   *  the admission closes them. */
  shutdown(): Promise<void>;
  beginQuit(): void;
  resume(): void;
}

interface Rec {
  job: Job;
  /** The held live plan (carries the writer's out-of-band instructions). */
  plan: PlanData | null;
  /** The plan in flight, and the promise that ends with it; a newer plan
   *  aborts it. Null when no plan is running. */
  planner: AbortController | null;
  planned: Promise<void>;
  planTimer?: ReturnType<typeof setTimeout>;
  /** The input classification in flight, and the promise that ends with it;
   *  a newer one aborts it. */
  classifier: AbortController | null;
  classified: Promise<void>;
  /** The archive path from the most recent write that actually committed. */
  publishedOutput: string | null;
  /** The archive's state when ZipKit last wrote or verified it. */
  fingerprint: string | null;
  observedArchive?: string;
  /** What the archive was known as before its drive went out of reach. */
  statusBeforeUnavailable?: ArchiveStatus;
}

/** One command in the effect queue. `before` is the state a finished job
 *  returns to once its effect ends. */
type Effect =
  | { id: string; kind: "create" }
  | { id: string; kind: "removeArchive"; before: JobState }
  | { id: string; kind: "removeOriginals"; method: RemovalMethod; before: JobState }
  | { id: string; kind: "verify"; before: JobState; settle(result: Promise<VerifyReport | null>): void }
  | { id: string; kind: "refresh"; settle(result: Promise<void>): void };

/** The manifest a job's archive is verified against: its name, or null when
 *  the job embeds none. */
/** The window holds back a level outside the range its field accepts; one that
 *  still arrives is refused, never corrected, so it cannot reach `queue.json`. */
function admitLevel(options: GuiOptions): void {
  if (!isWholeNumberIn(options.level, COMPRESSION_LEVEL_RANGE)) {
    throw new Error(`Compression level must be a whole number from ${COMPRESSION_LEVEL_RANGE.min} to ${COMPRESSION_LEVEL_RANGE.max}`);
  }
}

function manifestOf(options: GuiOptions): string | null {
  return options.manifest ? options.manifestName : null;
}

/** The code of an SDK failure. Undefined for plain or Node errors, so a Node
 *  `code` like ENOENT is never mistaken for an SDK code. */
function errCode(err: unknown): string | undefined {
  return isZipKitError(err) ? err.code : undefined;
}

/** The archive path of the source file a write found changed since the scan. */
function changedSourcePath(err: unknown): string | undefined {
  return isZipKitError(err) && err.code === "write.source-changed" ? err.subject : undefined;
}

/** A failed write's job message: a source file that changed while it was read
 *  is named, so the user knows the archive was refused rather than broken. */
function writeFailureMessage(err: unknown): Message {
  const changed = changedSourcePath(err);
  if (changed !== undefined) return message("job.sourceChanged", { path: changed });
  return message("job.writeFailed");
}

const ERRORED_KEYS: Record<Extract<RemovalRefusal, { reason: "error" }>["step"], MessageKey> = {
  location: "job.locationUnverified",
  verify: "job.verifyErrored",
  recheck: "job.recheckErrored",
};

/** Whether moving the archive to Trash cannot lose data: a done job whose
 *  originals are all still there, or a `failed` job whose write succeeded but a
 *  later step failed — unless that step deleted some originals for good, when
 *  the archive is all that is left of them. */
function archiveRemovable(job: Job): boolean {
  if (job.state === "done") return originalsIntact(job);
  return job.state === "failed" && (job.intent.originals !== "delete" || originalsIntact(job));
}

/** Why the originals may not be removed: the SDK's refusals. */
type TrashRefusal = NonNullable<AppRemoval["refusal"]>;

/** A removal as the engine handles it: the SDK's, with what became of each
 *  original in the app's buckets, or one that ended as a whole, carrying
 *  whatever ended it. */
export type AppRemoval = Omit<RemovalResult, "refusal" | "outcome"> & {
  refusal: Exclude<RemovalRefusal, { reason: "error" }> | { reason: "error"; step: "location" | "verify" | "recheck"; error: unknown } | null;
  outcome: TrashResult | null;
};

/** The message for a refused Trash; only the location sentence differs between
 *  a Move-to-Trash run and the command on a finished job. */
function refusalMessage(refusal: TrashRefusal, insideKey: MessageKey): Message {
  switch (refusal.reason) {
    case "inside":
      return message(insideKey);
    case "verify-failed":
      return message("job.verifyFailed");
    case "changed": {
      // Says how the originals differ from the archive, each kind only when
      // there is any, before what was done about it; the paths are in the
      // session log.
      const { missing, added, changed, unlisted } = refusal.comparison;
      const counts = [
        missing.length > 0 ? message("originals.missingFiles", { count: missing.length }) : null,
        added.length > 0 ? message("originals.addedFiles", { count: added.length }) : null,
        changed.length > 0 ? message("originals.changedFiles", { count: changed.length }) : null,
        unlisted.length > 0 ? message("originals.unlistedFolders", { count: unlisted.length }) : null,
      ].filter((part): part is Message => part !== null);
      return sentences([...counts, message("job.originalsChanged")])!;
    }
    case "error":
      return message(ERRORED_KEYS[refusal.step]);
  }
}

/** Whether a plan found a folder it could not list. */
function scanIncomplete(plan: PlanData): boolean {
  return plan.findings.some((f) => f.rule === "entry.unlisted");
}

export function createQueueEngine(deps: EngineDeps): QueueEngine {
  const recs = new Map<string, Rec>();
  const order: string[] = [];
  /** The effects waiting their turn, in request order. */
  let effects: Effect[] = [];
  /** The effect running now, with what cancels it. */
  let current: { id: string; kind: Effect["kind"]; aborter: AbortController } | null = null;
  /** The drain working through `effects`, while it runs. */
  let draining: Promise<void> | null = null;

  function snapshot(): Job[] {
    return order.map((id) => recs.get(id)?.job).filter((j): j is Job => j !== undefined);
  }
  function emit(): void {
    deps.emit(snapshot());
  }
  /** Apply a patch to the job. A run's outcome and a follow-up action's result
   *  are also added to the job's history, so the user can read, in order, what
   *  happened to it however many times it was re-planned since. */
  function set(rec: Rec, patch: Partial<Job>): void {
    const entry = historyEntry(patch);
    rec.job = { ...rec.job, ...patch };
    if (entry) rec.job = { ...rec.job, history: [...(rec.job.history ?? []), entry] };
  }
  function historyEntry(patch: Partial<Job>): JobHistoryEntry | null {
    if (patch.actionResult) return { at: Date.now(), ...patch.actionResult };
    if ((patch.state === "done" || patch.state === "failed") && patch.message) {
      return { at: Date.now(), severity: patch.state === "done" ? "info" : "error", message: patch.message };
    }
    return null;
  }
  /** What is at a path, or undefined when it could not be looked at: a failed
   *  look never claims anything is gone. */
  async function lookAt(rec: Rec, target: string, signal: AbortSignal): Promise<PathState | undefined> {
    try { return await deps.pathState(target, signal); }
    catch (error) {
      deps.log.warn("path state unavailable", { jobId: rec.job.id, target, error: errorInfo(error) });
      return undefined;
    }
  }
  function noteArchive(rec: Rec, state: PathState): void {
    const observed = state.kind === "present" ? state.fingerprint : state.kind;
    if (rec.observedArchive === observed) return;
    rec.observedArchive = observed;
    set(rec, { archiveRevision: (rec.job.archiveRevision ?? 0) + 1 });
    emit();
  }
  /** Look at the archive this job wrote and record what is there: a change
   *  since ZipKit last wrote or verified it, another file in its place, nothing
   *  at all, or a drive that is not connected. Resolves to whether the archive
   *  can be acted on now (true when that could not be told). */
  async function observeArchive(rec: Rec, signal: AbortSignal): Promise<boolean> {
    const output = rec.publishedOutput;
    if (!output) return false;
    const state = await lookAt(rec, output, signal);
    if (state === undefined) return true;
    noteArchive(rec, state);
    const id = rec.job.id;
    if (state.kind === "unavailable") {
      if (rec.job.archiveStatus !== "unavailable") {
        deps.log.warn("archive out of reach", { jobId: id, output });
        rec.statusBeforeUnavailable = rec.job.archiveStatus;
        set(rec, { archiveStatus: "unavailable", actionResult: { severity: "warning", message: message("action.archiveUnavailable") } });
        emit();
      }
      return false;
    }
    if (state.kind === "missing") {
      archiveGone(rec, output, "missing");
      return false;
    }
    if (rec.job.archiveStatus === "unavailable") {
      deps.log.info("archive within reach again", { jobId: id, output });
      set(rec, {
        archiveStatus: rec.statusBeforeUnavailable ?? "written",
        actionResult: { severity: "info", message: message("action.archiveAvailableAgain") },
      });
      rec.statusBeforeUnavailable = undefined;
      emit();
    }
    if (rec.fingerprint !== null && !sameFile(state.fingerprint, rec.fingerprint)) {
      archiveGone(rec, output, "replaced");
      return false;
    }
    if (state.fingerprint !== rec.fingerprint && rec.job.archiveStatus !== "changed") {
      deps.log.info("archive changed since it was last checked", { jobId: id, output });
      set(rec, { archiveStatus: "changed", actionResult: { severity: "warning", message: message("report.archiveChanged") } });
      emit();
    }
    return true;
  }
  /** The archive ZipKit made is no longer at its path: moved or deleted, or
   *  another file put there, outside ZipKit. A file in its place is left alone.
   *  While every original is still there the job goes back to planning so it
   *  can be created again; once some are gone it stays finished and says so. */
  function archiveGone(rec: Rec, output: string, how: "missing" | "replaced"): void {
    const id = rec.job.id;
    rec.publishedOutput = null;
    rec.fingerprint = null;
    const entries = rec.job.entries;
    const originalsGone = entries
      ? entries.some((entry) => entry.kind === "missing")
      : rec.job.state === "done" && removesOriginals(rec.job.intent);
    deps.log.warn(how === "missing" ? "archive missing" : "archive replaced", { jobId: id, output, originalsGone });
    if (originalsGone) {
      set(rec, {
        archiveWritten: false,
        archiveStatus: "missing",
        actionResult: {
          severity: "error",
          message: message(how === "missing" ? "action.archiveMissingOriginalsGone" : "action.archiveReplacedOriginalsGone"),
        },
      });
      emit();
      return;
    }
    set(rec, { actionResult: { severity: "warning", message: message(how === "missing" ? "action.archiveMissing" : "action.archiveReplaced") } });
    resetForRecreate(rec);
  }
  /** Back to an editable, re-planned job whose archive is gone, so options can
   *  be adjusted and the archive created again. */
  function resetForRecreate(rec: Rec): void {
    set(rec, {
      output: undefined,
      summary: undefined,
      writable: undefined,
      message: undefined,
      actionResult: undefined,
      archiveWritten: false,
      archiveStatus: undefined,
      archiveBytes: undefined,
      originalsChanges: undefined,
    });
    rec.publishedOutput = null;
    rec.fingerprint = null;
    emit();
    startPlan(rec);
  }
  /** Record a verification that passed, against the archive as it stood when it began. */
  function markVerified(rec: Rec, fingerprint: string | null): void {
    if (fingerprint !== null) rec.fingerprint = fingerprint;
    set(rec, { archiveStatus: "verified" });
  }

  /** Remove the originals after every check, the SDK's, in order: the
   *  refusal, or what became of each original. */
  async function removeAfterChecks(
    rec: Rec,
    output: string,
    inputs: string[],
    method: RemovalMethod,
    signal: AbortSignal,
    onEvent: (e: LogEvent) => void,
    removed: string[] = [],
  ): Promise<{ refusal: TrashRefusal; outcome: null } | { refusal: null; outcome: TrashResult }> {
    const id = rec.job.id;
    set(rec, { originalsChanges: undefined });
    let check: AppRemoval;
    try {
      check = await deps.removeOriginals(output, inputs, removed, rec.job.options, method, signal, onEvent);
    } catch (error) {
      // The check as a whole ended, which the recheck's message covers: the
      // originals were not checked, and none was removed.
      check = { refusal: { reason: "error", step: "recheck", error }, verified: null, outcome: null };
    }
    if (check.verified) markVerified(rec, check.verified.fingerprint);
    const refusal = check.refusal;
    if (refusal === null) return { refusal: null, outcome: check.outcome! };
    switch (refusal.reason) {
      case "inside":
        deps.log.error("trash blocked: archive inside source", { jobId: id, output });
        break;
      case "verify-failed":
        deps.log.error("trash blocked: verification failed; originals kept", { jobId: id, output });
        break;
      case "changed": {
        const { missing, added, changed, unlisted } = refusal.comparison;
        deps.log.error("trash blocked: originals changed since archiving", {
          jobId: id, added: added.length, missing: missing.length, changed: changed.length, unlisted: unlisted.length,
        });
        set(rec, { originalsChanges: { missing, added, changed, unlisted } });
        break;
      }
      case "error":
        deps.log.error(`trash blocked: ${refusal.step} check errored; originals kept`, { jobId: id, error: errorInfo(refusal.error) });
        break;
    }
    return { refusal, outcome: null };
  }

  /** A progress sink for one run of an action on a job: Create's fresh plan,
   *  write, verify and recheck share its one run, so Progress heads them once. */
  function progressFor(id: string, action: JobAction): (e: LogEvent) => void {
    return deps.progress(id, action);
  }

  /** Classify a job's inputs on disk and store the result as `entries`, so the
   *  label, the input list, and the originals-still-present check stay accurate.
   *  A newer classification supersedes this one. Best-effort: a pathKinds
   *  failure leaves the prior entries rather than crashing. */
  function classifyInputs(rec: Rec): Promise<void> {
    if (!deps.admission.accepting()) return Promise.resolve();
    rec.classifier?.abort();
    const aborter = new AbortController();
    rec.classifier = aborter;
    rec.classified = classify(rec, aborter);
    return rec.classified;
  }
  async function classify(rec: Rec, aborter: AbortController): Promise<void> {
    try {
      const entries = await deps.pathKinds(rec.job.inputs, aborter.signal);
      if (aborter.signal.aborted) return;
      rec.classifier = null;
      set(rec, { entries });
      emit();
    } catch (err) {
      if (aborter.signal.aborted) return;
      rec.classifier = null;
      deps.log.warn("input classification failed", { jobId: rec.job.id, error: errorInfo(err) });
    }
  }

  /** Classify the job's inputs now, for a decision that must not rest on an
   *  older look. False when they could not be looked at. */
  async function freshEntries(rec: Rec): Promise<boolean> {
    rec.classifier?.abort();
    rec.classifier = null;
    try {
      set(rec, { entries: await deps.pathKinds(rec.job.inputs) });
      emit();
      return true;
    } catch (err) {
      deps.log.warn("input classification failed", { jobId: rec.job.id, error: errorInfo(err) });
      return false;
    }
  }

  /** Whether the effect queue holds a Create for this job. */
  function createQueued(id: string): boolean {
    return effects.some((effect) => effect.id === id && effect.kind === "create");
  }

  /** Plan the job now, superseding any plan in flight for it. */
  function startPlan(rec: Rec): void {
    if (!deps.admission.accepting()) return;
    clearTimeout(rec.planTimer);
    rec.planTimer = undefined;
    rec.planner?.abort();
    const aborter = new AbortController();
    rec.planner = aborter;
    set(rec, { state: "planning", message: undefined, actionResult: undefined, errorCode: undefined });
    emit();
    rec.planned = planJob(rec, aborter.signal);
  }

  async function planJob(rec: Rec, signal: AbortSignal): Promise<void> {
    const id = rec.job.id;
    try {
      const plan = await deps.plan(rec.job.inputs, rec.job.options, signal, progressFor(id, "plan"));
      // A newer plan, a cancel or quit took over: the result is not this job's now.
      if (signal.aborted) return;
      rec.plan = plan;
      // A Create asked for while this plan ran waits its turn now.
      const queued = plan.writable && createQueued(id);
      set(rec, {
        output: plan.output,
        summary: plan.summary,
        writable: plan.writable,
        scanIncomplete: scanIncomplete(plan),
        state: queued ? "queued" : plan.writable ? "ready" : "needs-attention",
        message: plan.writable ? undefined : message("job.blocking", { count: plan.summary.errors }),
      });
      deps.log.info("job planned", {
        jobId: id,
        writable: plan.writable,
        included: plan.summary.included,
        excluded: plan.summary.excluded,
        errors: plan.summary.errors,
      });
    } catch (err) {
      if (signal.aborted) return;
      rec.plan = null;
      set(rec, {
        state: "needs-attention",
        writable: false,
        scanIncomplete: undefined,
        message: message("job.prepareFailed"),
        errorCode: errCode(err),
      });
      deps.log.error("job plan failed", { jobId: id, error: errorInfo(err) });
    }
    rec.planner = null;
    emit();
  }

  /** Wait for the job's plan, starting a delayed one now: a Create waits for
   *  the plan of the settings it was asked with. */
  async function planSettled(rec: Rec, signal: AbortSignal): Promise<void> {
    // A cancel or quit stops the wait, whether or not the plan has noticed.
    const stopped = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    while (!signal.aborted && (rec.planTimer !== undefined || rec.planner !== null)) {
      if (rec.planTimer !== undefined) startPlan(rec);
      await Promise.race([rec.planned, stopped]);
    }
  }

  /** Re-plan fresh and write the archive. Resolves to the written output, or
   *  null when the job stopped (its state already says why). */
  async function writeStage(
    rec: Rec,
    signal: AbortSignal,
    onEvent: (e: LogEvent) => void,
  ): Promise<{ output: string; bytes: number } | null> {
    const id = rec.job.id;
    // Re-plan fresh: the world may have changed since this job was enqueued.
    const reviewed = rec.plan;
    let plan: PlanData;
    try {
      plan = await deps.plan(rec.job.inputs, rec.job.options, signal, onEvent);
      rec.plan = plan;
      set(rec, { output: plan.output, summary: plan.summary, writable: plan.writable, scanIncomplete: scanIncomplete(plan) });
    } catch (err) {
      // The earlier plan no longer describes this job, so the report explains
      // the failure rather than that stale plan.
      rec.plan = null;
      set(rec, {
        state: "needs-attention",
        writable: false,
        scanIncomplete: undefined,
        message: message("job.prepareFailed"),
        errorCode: errCode(err),
      });
      deps.log.error("job run re-plan failed", { jobId: id, error: errorInfo(err) });
      return null;
    }
    if (!plan.writable) {
      set(rec, { state: "needs-attention", message: message("job.noLongerWritable") });
      deps.log.warn("job run skipped: no longer writable", { jobId: id, errors: plan.summary.errors });
      return null;
    }
    // The fresh plan is held either way; when it would show another Report than
    // the one the user reviewed, it waits for review instead of being written.
    // A plan that landed just before an immediate Create counts as reviewed.
    if (reviewed && reportChanged(reviewed, plan)) {
      set(rec, { state: "needs-attention", message: message("job.planChanged") });
      deps.log.warn("job run stopped: the files changed since the plan was reviewed", { jobId: id });
      return null;
    }

    let bytes: number | null;
    rec.publishedOutput = null;
    set(rec, { archiveWritten: false });
    try {
      bytes = await deps.write(plan, signal, onEvent);
    } catch (err) {
      set(rec, { state: "failed", message: writeFailureMessage(err) });
      deps.log.error("job write failed", { jobId: id, error: errorInfo(err) });
      return null;
    }
    if (bytes === null) {
      // Another file took the archive's name since the plan; nothing was written.
      set(rec, { state: "needs-attention", writable: false, message: message("job.noLongerWritable") });
      deps.log.warn("job write refused: the output appeared since the plan", { jobId: id });
      return null;
    }
    rec.publishedOutput = plan.output;
    const written = await lookAt(rec, plan.output, signal);
    rec.fingerprint = written?.kind === "present" ? written.fingerprint : null;
    if (written) noteArchive(rec, written);
    set(rec, { archiveWritten: true, archiveStatus: "written", archiveBytes: bytes });
    return { output: plan.output, bytes };
  }

  async function runJob(rec: Rec, signal: AbortSignal): Promise<void> {
    const id = rec.job.id;
    const intent = rec.job.intent;
    const removal: RemovalMethod | null = intent.originals === "keep" ? null : intent.originals;
    // A run that removes its originals and failed after its archive was written
    // resumes there: the archive stays, and the checks and the removal run again
    // for the inputs still present (a partial removal already took the others).
    const resumeFrom = removal ? rec.publishedOutput : null;
    const onEvent = progressFor(id, "create");
    set(rec, { state: "running", message: undefined, actionResult: undefined, errorCode: undefined });
    emit();
    deps.log.info(resumeFrom ? "job run resumed after its write" : "job run started", {
      jobId: id,
      verify: intent.verify,
      originals: intent.originals,
    });
    try {
      let output: string;
      let inputs = rec.job.inputs;
      if (resumeFrom) {
        output = resumeFrom;
        let entries: InputEntry[];
        try {
          entries = await deps.pathKinds(rec.job.inputs);
        } catch (err) {
          set(rec, { state: "failed", message: message("job.prepareFailed") });
          deps.log.error("job resume could not classify inputs", { jobId: id, error: errorInfo(err) });
          return;
        }
        set(rec, { entries });
        inputs = entries.filter((e) => e.kind !== "missing").map((e) => e.path);
      } else {
        const written = await writeStage(rec, signal, onEvent);
        if (!written) return;
        output = written.output;
        if (!removal) {
          await finishKept(rec, output, written.bytes, signal, onEvent);
          return;
        }
      }

      // The originals leave: every check, then Trash or deletion — kept on any failure.
      if (!removal) return; // a run that keeps them finished above
      const gone = rec.job.inputs.filter((p) => !inputs.includes(p));
      const { refusal, outcome: removed } = await removeAfterChecks(rec, output, inputs, removal, signal, onEvent, gone);
      if (refusal) {
        const again = resumeFrom !== null && refusal.reason === "verify-failed";
        set(rec, {
          state: "failed",
          message: again ? message("job.verifyFailedAgain") : refusalMessage(refusal, "job.insideSource"),
        });
        return;
      }
      if (!trashConfirmed(removed)) {
        set(rec, {
          state: "failed",
          message: message("job.savedVerifiedPartial", { detail: describeOriginalsRemoval(removed, removal) }),
        });
        deps.log.error("job removal of the originals not fully confirmed after verify", { jobId: id, method: removal, ...removed });
        void classifyInputs(rec);
        return;
      }
      const goneNow = removed.gone?.length ?? 0;
      set(rec, {
        state: "done",
        message: goneNow === 0
          ? message(removal === "trash" ? "job.archivedAndTrashed" : "job.archivedAndDeleted", { count: removed.moved.length })
          : sentences([message("job.savedVerifiedShort"), describeRemovalDone(removed, removal, "trash")])!,
      });
      deps.log.info(removal === "trash" ? "job archived and trashed" : "job archived and originals deleted", { jobId: id, output, count: removed.moved.length, gone: goneNow });
      // The originals now read as gone, so the job offers what is left to do.
      void classifyInputs(rec);
    } catch (error) {
      set(rec, { state: "failed", message: message(removal === "delete" ? "job.deleteFailed" : "job.trashFailed") });
      deps.log.error("job archive action failed", { jobId: id, error: errorInfo(error) });
    } finally {
      emit();
    }
  }

  /** A run that keeps its originals: done once written, or once verified when
   *  the user chose to verify. A failed verification keeps the archive, which
   *  the job then offers to reveal or move to Trash. */
  async function finishKept(rec: Rec, output: string, bytes: number, signal: AbortSignal, onEvent: (e: LogEvent) => void): Promise<void> {
    const id = rec.job.id;
    if (!rec.job.intent.verify) {
      set(rec, { state: "done", message: message("job.saved", { size: { bytes } }) });
      deps.log.info("job saved", { jobId: id, output, bytes });
      return;
    }
    let verified: boolean;
    const seen = rec.fingerprint;
    try {
      verified = await deps.verify(output, signal, onEvent, manifestOf(rec.job.options));
    } catch (err) {
      set(rec, { state: "failed", message: message("job.savedVerifyErrored") });
      deps.log.error("job saved; verification errored", { jobId: id, output, error: errorInfo(err) });
      return;
    }
    if (!verified) {
      set(rec, { state: "failed", message: message("job.savedNotVerified") });
      deps.log.error("job saved; verification failed", { jobId: id, output });
      return;
    }
    markVerified(rec, seen);
    set(rec, { state: "done", message: message("job.savedVerified", { size: { bytes } }) });
    deps.log.info("job saved and verified", { jobId: id, output, bytes });
  }

  /** A job is runnable when it is writable-and-waiting (`ready`, or
   *  `needs-attention` only for review of a still-writable plan), waiting its
   *  turn (`queued`), or a retryable terminal (`failed`). */
  function isRunnable(job: Job): boolean {
    if (job.state === "needs-attention") return job.writable === true;
    return job.state === "ready" || job.state === "queued" || job.state === "failed";
  }

  /** Whether a job may not run at all: a Move-to-Trash job without the
   *  manifest it is verified against, or one whose plan could not list a
   *  folder. Checked when a run is requested and again when its turn comes. */
  function refusesRun(rec: Rec): boolean {
    if (manifestRequiredButMissing(rec.job.intent, rec.job.options.manifest)) {
      deps.log.warn("job run refused: removing the originals needs the manifest", { jobId: rec.job.id });
      return true;
    }
    if (scanBlocksRemoval(rec.job)) {
      deps.log.warn("job run refused: a folder could not be listed", { jobId: rec.job.id });
      return true;
    }
    return false;
  }

  /** Queue an effect, or start it now when nothing else runs. A job's own
   *  command shows it waiting (`queued`) while another effect runs. */
  function enqueue(effect: Effect, rec: Rec): void {
    effects.push(effect);
    if (draining && effect.kind !== "refresh" && rec.job.state !== "planning") {
      set(rec, { state: "queued", message: undefined, actionResult: undefined, errorCode: undefined });
      emit();
    }
    startDrain();
  }
  function startDrain(): void {
    if (draining) return;
    draining = drain().finally(() => {
      draining = null;
      // An effect queued as the last one ended starts the next drain.
      if (effects.length > 0 && deps.admission.accepting()) startDrain();
    });
  }

  /** Work through the effects one at a time, in request order. */
  async function drain(): Promise<void> {
    for (;;) {
      if (!deps.admission.accepting()) return;
      const effect = effects.shift();
      if (!effect) return;
      const rec = recs.get(effect.id);
      if (!rec) {
        if (effect.kind === "verify") effect.settle(Promise.resolve(null));
        if (effect.kind === "refresh") effect.settle(Promise.resolve());
        continue;
      }
      const aborter = new AbortController();
      current = { id: effect.id, kind: effect.kind, aborter };
      try {
        await perform(effect, rec, aborter.signal);
      } finally {
        current = null;
      }
    }
  }

  async function perform(effect: Effect, rec: Rec, signal: AbortSignal): Promise<void> {
    switch (effect.kind) {
      case "create":
        await planSettled(rec, signal);
        if (signal.aborted || !isRunnable(rec.job) || refusesRun(rec)) return;
        await runJob(rec, signal);
        return;
      case "verify": {
        const work = verifyArchive(rec, effect.before, signal);
        effect.settle(work);
        await work.catch(() => {});
        return;
      }
      case "refresh": {
        const work = refreshJob(rec, signal);
        effect.settle(work);
        await work;
        return;
      }
      case "removeArchive":
        await removeArchive(rec, effect.before, signal);
        return;
      case "removeOriginals":
        await removeOriginals(rec, effect.method, effect.before, signal);
        return;
    }
  }

  /** Begin a finished job's own effect: false when the job changed while the
   *  effect waited, such as a Refresh ahead of it finding the archive gone. */
  function beginFinished(rec: Rec, before: JobState): boolean {
    if (rec.job.state !== "queued" && rec.job.state !== before) return false;
    set(rec, { state: "running", actionResult: undefined });
    emit();
    return true;
  }
  /** End a finished job's effect in the state it began from, unless the
   *  effect itself moved the job on. */
  function endFinished(rec: Rec, before: JobState, result?: Job["actionResult"] | null): void {
    const patch: Partial<Job> = rec.job.state === "running" ? { state: before } : {};
    if (result) patch.actionResult = result;
    set(rec, patch);
    emit();
  }

  async function removeArchive(rec: Rec, before: JobState, signal: AbortSignal): Promise<void> {
    const id = rec.job.id;
    const output = rec.publishedOutput;
    if (!output || !beginFinished(rec, before)) return;
    deps.log.info("remove archive started", { jobId: id, output });
    let result: Job["actionResult"] | null = null;
    let removed = false;
    try {
      if (await observeArchive(rec, signal)) {
        // The originals are looked at again: the archive may be all that is
        // left of any that went since the job was last looked at.
        if (!(await freshEntries(rec)) || !archiveRemovable({ ...rec.job, state: before })) {
          result = { severity: "error", message: message("action.archiveKept") };
          deps.log.warn("archive removal refused: originals gone or out of reach", { jobId: id, output });
        } else {
          const trashed = await deps.trash([output], signal);
          if (trashed.failed.length > 0) {
            result = { severity: "error", message: message("action.archiveTrashFailed") };
            deps.log.error("remove archive failed", { jobId: id, failed: trashed.failed });
          } else {
            removed = true;
          }
        }
      }
    } catch (err) {
      result = { severity: "error", message: message("action.archiveTrashFailed") };
      deps.log.error("remove archive failed", { jobId: id, error: errorInfo(err) });
    }
    endFinished(rec, before, result);
    if (!removed) return;
    deps.log.info("archive removed", { jobId: id, output });
    set(rec, { actionResult: { severity: "info", message: message("action.archiveTrashed") } });
    resetForRecreate(rec);
  }

  async function removeOriginals(rec: Rec, method: RemovalMethod, before: JobState, signal: AbortSignal): Promise<void> {
    const id = rec.job.id;
    const trash = method === "trash";
    const output = rec.publishedOutput;
    if (!beginFinished(rec, before)) return;
    // Null when the archive turned out to be gone: that already says so.
    let result: NonNullable<Job["actionResult"]> | null;
    try {
      if (!output) {
        result = { severity: "error", message: message("action.noArchive") };
      } else if (!(await observeArchive(rec, signal))) {
        result = null;
      } else if (!(await freshEntries(rec))) {
        result = { severity: "error", message: message("originals.unreadable") };
      } else if (rec.job.entries!.some((entry) => entry.kind === "unavailable")) {
        result = { severity: "error", message: message("originals.unavailable") };
      } else if (!rec.job.entries!.some(present)) {
        result = { severity: "warning", message: message("action.noOriginals") };
      } else {
        // Only the originals still there are removed. Any already gone are
        // left out of the recheck as well, so what was archived from them
        // is not read as missing; what remains must still match.
        const inputs = rec.job.entries!.filter(present).map((entry) => entry.path);
        const missing = rec.job.entries!.filter((entry) => entry.kind === "missing").map((entry) => entry.path);
        const { refusal, outcome: removed } = await removeAfterChecks(rec, output, inputs, method, signal, progressFor(id, method), missing);
        if (refusal && signal.aborted) {
          result = { severity: "warning", message: message(trash ? "action.originalsTrashCancelled" : "action.originalsDeleteCancelled") };
          deps.log.info("removing originals cancelled", { jobId: id, method });
        } else if (refusal) {
          result = { severity: "error", message: refusalMessage(refusal, "action.archiveInsideOriginal") };
        } else if (trashConfirmed(removed)) {
          result = { severity: "info", message: describeRemovalDone(removed, method, "action", missing.length) };
          deps.log.info(trash ? "originals trashed" : "originals deleted", { jobId: id, count: removed.moved.length, gone: missing.length + (removed.gone?.length ?? 0) });
        } else {
          result = { severity: "error", message: describeOriginalsRemoval(removed, method) };
          deps.log.error("removing originals not fully confirmed", { jobId: id, method, ...removed });
        }
      }
    } catch (err) {
      result = { severity: "error", message: message(trash ? "action.originalsTrashFailed" : "action.originalsDeleteFailed") };
      deps.log.error("removing originals failed", { jobId: id, method, error: errorInfo(err) });
    }
    endFinished(rec, before, result);
    // Re-classify so removed originals read as missing and the commands hide.
    void classifyInputs(rec);
  }

  async function verifyArchive(rec: Rec, before: JobState, signal: AbortSignal): Promise<VerifyReport | null> {
    const id = rec.job.id;
    const output = rec.publishedOutput;
    if (!output || !beginFinished(rec, before)) return null;
    deps.log.info("verify started", { jobId: id, output });
    let result: Job["actionResult"] | null = null;
    try {
      if (!(await observeArchive(rec, signal))) return null;
      const seen = rec.observedArchive;
      const report = await deps.inspect(output, signal, deps.progress(id, "verify"), manifestOf(rec.job.options));
      if (report.ok) {
        markVerified(rec, seen === undefined || seen === "missing" || seen === "unavailable" ? null : seen);
        result = { severity: "info", message: message("history.verified", { count: report.summary.total }) };
      } else {
        const s = report.summary;
        const problems = s.crc32Failed + s.unreadable + s.localMismatched + s.sha256Mismatched + s.manifestMismatched +
          report.missing.length + report.extra.length;
        set(rec, { archiveStatus: rec.job.archiveStatus === "verified" ? "changed" : rec.job.archiveStatus });
        result = { severity: "error", message: message("history.verifyFailed", { count: Math.max(problems, 1) }) };
      }
      deps.log.info("verify done", { jobId: id, output, ok: report.ok });
      return report;
    } catch (err) {
      deps.log.error("verify failed", { jobId: id, output, error: errorInfo(err) });
      result = { severity: "error", message: message("action.verifyErrored") };
      throw err;
    } finally {
      endFinished(rec, before, result);
    }
  }

  async function refreshJob(rec: Rec, signal: AbortSignal): Promise<void> {
    const state = rec.job.state;
    if (state === "running" || state === "queued" || state === "planning") return;
    await classifyInputs(rec);
    if ((state === "done" || state === "failed") && rec.publishedOutput) await observeArchive(rec, signal);
  }

  /** Withdraw a Create asked for while the job was planning: an edit since
   *  then means it no longer describes what the user confirmed. */
  function dropCreate(id: string): void {
    dropQueued(id, "create");
    if (current?.id === id && current.kind === "create") current.aborter.abort();
  }

  function changeInputs(rec: Rec, inputs: string[]): void {
    dropCreate(rec.job.id);
    set(rec, { inputs });
    deps.log.info("job inputs changed", { jobId: rec.job.id, inputs: inputs.length });
    void classifyInputs(rec);
    startPlan(rec);
  }

  /** Take a job's queued effects out of the queue: all of them, or one kind.
   *  A Verify or Refresh waiting on them settles with nothing to report. */
  function dropQueued(id: string, kind?: Effect["kind"]): Effect[] {
    const dropped = effects.filter((effect) => effect.id === id && (kind === undefined || effect.kind === kind));
    effects = effects.filter((effect) => !dropped.includes(effect));
    for (const effect of dropped) {
      if (effect.kind === "verify") effect.settle(Promise.resolve(null));
      if (effect.kind === "refresh") effect.settle(Promise.resolve());
    }
    return dropped;
  }

  /** Close new effects, cancel the running one and empty the queue: a job
   *  that waited its turn goes back to where it was. */
  function stopQueue(): void {
    deps.admission.beginClosing();
    for (const effect of effects.splice(0)) {
      const rec = recs.get(effect.id);
      if (effect.kind === "verify") effect.settle(Promise.resolve(null));
      if (effect.kind === "refresh") effect.settle(Promise.resolve());
      if (!rec || rec.job.state !== "queued") continue;
      set(rec, { state: effect.kind === "create" || effect.kind === "refresh" ? "ready" : effect.before });
    }
    current?.aborter.abort();
    for (const rec of recs.values()) {
      clearTimeout(rec.planTimer);
      rec.planTimer = undefined;
      rec.planner?.abort();
      rec.planner = null;
      rec.classifier?.abort();
      rec.classifier = null;
    }
    emit();
  }

  function newRec(job: Job): Rec {
    return { job, plan: null, planner: null, planned: Promise.resolve(), classifier: null, classified: Promise.resolve(), publishedOutput: null, fingerprint: null };
  }

  return {
    snapshot,
    add(inputs, options, intent = SAFEST_INTENT) {
      if (!deps.admission.accepting()) throw new Error("The app is shutting down");
      admitLevel(options);
      const id = deps.newId();
      const rec = newRec({ id, inputs, options, intent, state: "planning" });
      recs.set(id, rec);
      order.push(id);
      deps.log.info("job added", { jobId: id, inputs: inputs.length });
      void classifyInputs(rec);
      startPlan(rec);
      return id;
    },
    update(id, patch) {
      if (!deps.admission.acceptingEdits()) throw new Error("The app is shutting down");
      const rec = recs.get(id);
      // No edits to a job the shared rule locks: `running` (in flight), `queued`
      // (committed to run — editing it must go through cancel first, which un-queues
      // and re-plans, or a store-only edit such as an intent flip would leave it
      // queued and auto-run later under the new intent), or `done` (its options are
      // the record of the archive on disk). A late click or IPC edit can still
      // arrive after the job finishes; accepting it would drop
      // the published output the Trash command needs and re-plan the result away.
      if (!rec || !isEditable(rec.job)) return;
      if (patch.options !== undefined) admitLevel(patch.options);
      // A Create asked for while planning describes the settings at that click.
      // Later edits must not turn a save request into an unconfirmed Trash run.
      if ((patch.intent !== undefined && !sameIntent(patch.intent, rec.job.intent)) ||
          (patch.options !== undefined && !optionsEqual(patch.options, rec.job.options))) dropCreate(id);
      let replan = false;
      if (patch.intent !== undefined) {
        set(rec, { intent: patch.intent });
        deps.log.info("job intent set", { jobId: id, verify: patch.intent.verify, originals: patch.intent.originals });
      }
      if (patch.options !== undefined) {
        // Only a change to a plan-affecting option warrants a fresh dry run;
        // write-only edits (level, comment, hash) are stored without re-planning,
        // so they never re-emit an identical report.
        const planChanged = planAffectingChanged(rec.job.options, patch.options);
        set(rec, { options: patch.options });
        if (planChanged) replan = true;
      }
      // A re-plan emits on its own; a store-only change (intent / write-only
      // option) still must emit so the renderer sees the new state.
      if (replan) {
        // Accept options now; quit saves them without waiting for a scan. The
        // old plan is aborted at once, so it cannot land during this delay.
        clearTimeout(rec.planTimer);
        rec.planner?.abort();
        rec.planner = null;
        rec.plan = null;
        set(rec, { state: "planning", writable: false, message: undefined, actionResult: undefined, errorCode: undefined });
        rec.planTimer = setTimeout(() => startPlan(rec), 250);
      }
      emit();
    },
    addInputs(id, paths) {
      if (!deps.admission.accepting()) throw new Error("The app is shutting down");
      const rec = recs.get(id);
      if (!rec || !isEditable(rec.job)) return { accepted: [], duplicates: 0 };
      const admission = planInputAdmission(rec.job.inputs, paths);
      if (admission.accepted.length > 0) changeInputs(rec, [...rec.job.inputs, ...admission.accepted]);
      return admission;
    },
    removeInput(id, path) {
      if (!deps.admission.accepting()) throw new Error("The app is shutting down");
      const rec = recs.get(id);
      if (!rec || !isEditable(rec.job) || rec.job.inputs.length <= 1 || !rec.job.inputs.includes(path)) return;
      const inputs = rec.job.inputs.filter((input) => input !== path);
      if (inputs.length > 0) changeInputs(rec, inputs);
    },
    remove(id) {
      if (!deps.admission.accepting()) throw new Error("The app is shutting down");
      const rec = recs.get(id);
      if (!rec || rec.job.state === "running") return;
      clearTimeout(rec.planTimer);
      rec.planner?.abort();
      rec.classifier?.abort();
      if (current?.id === id) current.aborter.abort();
      dropQueued(id);
      recs.delete(id);
      const i = order.indexOf(id);
      if (i >= 0) order.splice(i, 1);
      deps.log.info("job removed", { jobId: id });
      emit();
    },
    cancel(id) {
      const rec = recs.get(id);
      if (!rec) return;
      if (current?.id === id) {
        deps.log.info("job cancel requested", { jobId: id, state: rec.job.state });
        current.aborter.abort();
        // A running effect stops at its next boundary; a Create still waiting
        // for its plan stops that plan too.
        if (rec.job.state !== "planning") return;
      }
      const dropped = dropQueued(id);
      // A `queued` job is only waiting its turn — it has no work in flight. Out
      // of the queue, a Create re-plans, so the job returns to an editable,
      // freshly-evaluated state (the world may have changed while it waited);
      // a finished job's command returns it to where it was.
      if (rec.job.state === "queued") {
        deps.log.info("queued job cancelled", { jobId: id });
        const finished = dropped.find((effect) => "before" in effect);
        if (finished && "before" in finished) {
          set(rec, { state: finished.before });
          emit();
        } else startPlan(rec);
        return;
      }
      if (rec.planTimer !== undefined) {
        clearTimeout(rec.planTimer);
        rec.planTimer = undefined;
        set(rec, { state: "needs-attention", writable: false });
        emit();
        return;
      }
      if (rec.planner) {
        deps.log.info("job cancel requested", { jobId: id, state: rec.job.state });
        rec.planner.abort();
        rec.planner = null;
        rec.plan = null;
        set(rec, { state: "needs-attention", writable: false, scanIncomplete: undefined, message: message("job.prepareFailed") });
        emit();
      }
    },
    run(id, scope) {
      if (!deps.admission.accepting()) throw new Error("The app is shutting down");
      const rec = recs.get(id);
      if (rec && (!scope || !sameIntent(scope.intent, rec.job.intent) ||
          scope.inputs.length !== rec.job.inputs.length || scope.inputs.some((input, i) => input !== rec.job.inputs[i]))) {
        throw new Error("The job changed since this action was confirmed");
      }
      if (!rec) return;
      const s = rec.job.state;
      // Accept a request for a runnable job (ready / retryable / reviewed after a
      // change) or one still (re)planning, which waits for its plan in its turn,
      // so "edit a field, then Create" is not dropped mid-re-plan.
      if (s !== "planning" && !(s !== "queued" && isRunnable(rec.job))) return;
      if (refusesRun(rec) || createQueued(id)) return;
      deps.log.info("job run requested", { jobId: id, state: s });
      enqueue({ id, kind: "create" }, rec);
    },
    removeArchive(id) {
      if (!deps.admission.accepting()) throw new Error("The app is shutting down");
      const rec = recs.get(id);
      if (!rec || !rec.publishedOutput || !archiveRemovable(rec.job)) return;
      deps.log.info("remove archive requested", { jobId: id, output: rec.publishedOutput });
      enqueue({ id, kind: "removeArchive", before: rec.job.state }, rec);
    },
    removeOriginals(id, method) {
      if (!deps.admission.accepting()) throw new Error("The app is shutting down");
      const rec = recs.get(id);
      // A job that removed its originals on its run offers this again only when
      // some were put back, say from the Trash.
      if (!rec || rec.job.state !== "done") return;
      // Offered only when the archive carries the manifest its verify needs,
      // and when the scan listed every folder, so nothing unarchived is removed.
      if (!rec.job.options.manifest) {
        deps.log.warn("removing originals refused: the archive has no manifest", { jobId: id, method });
        return;
      }
      if (rec.job.scanIncomplete) {
        deps.log.warn("removing originals refused: a folder could not be listed", { jobId: id, method });
        return;
      }
      deps.log.info("removing originals requested", { jobId: id, method, count: rec.job.inputs.length });
      enqueue({ id, kind: "removeOriginals", method, before: "done" }, rec);
    },
    verify(id) {
      if (!deps.admission.accepting()) throw new Error("The app is shutting down");
      const rec = recs.get(id);
      if (!rec || !rec.publishedOutput || (rec.job.state !== "done" && rec.job.state !== "failed")) return Promise.resolve(null);
      deps.log.info("verify requested", { jobId: id, output: rec.publishedOutput });
      return new Promise((resolve, reject) => {
        enqueue({ id, kind: "verify", before: rec.job.state, settle: (result) => result.then(resolve, reject) }, rec);
      });
    },
    refresh(id) {
      const rec = recs.get(id);
      if (!rec || !deps.admission.accepting()) return Promise.resolve();
      const state = rec.job.state;
      if (state === "running" || state === "queued" || state === "planning") return Promise.resolve();
      return new Promise((resolve, reject) => {
        enqueue({ id, kind: "refresh", settle: (result) => result.then(resolve, reject) }, rec);
      });
    },
    getPlan(id) {
      return recs.get(id)?.plan ?? null;
    },
    restore(saved) {
      const restored = saved.map((s) => newRec({ ...s, intent: SAFEST_INTENT, state: "planning" }));
      for (const rec of restored) {
        recs.set(rec.job.id, rec);
        order.push(rec.job.id);
      }
      if (saved.length > 0) emit();
      for (const rec of restored) {
        void classifyInputs(rec);
        startPlan(rec);
      }
    },
    hasRunningJob() {
      for (const rec of recs.values()) if (rec.job.state === "running") return true;
      return false;
    },
    async shutdown() {
      const running = [...recs.values()].flatMap((rec) => [rec.planned, rec.classified]);
      stopQueue();
      await Promise.all([draining, ...running]);
    },
    beginQuit() { stopQueue(); },
    resume() {
      if (deps.admission.accepting()) return;
      deps.admission.reopen();
      // Quit stopped every plan in flight; each such job plans afresh.
      for (const rec of recs.values()) if (rec.job.state === "planning") startPlan(rec);
      emit();
    },
  };
}
