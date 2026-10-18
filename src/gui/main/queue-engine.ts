/**
 * The queue engine: the job records and the state machine that drives them.
 * Plans each job in the background on add (non-blocking — never waiting on a
 * running write). Jobs are run one at a time, but only on explicit request: the
 * user creates a specific job's archive, the engine serializes the requests, and
 * runs each: write, then verify when chosen, then, when the originals are to
 * leave, every check and a per-item Trash or permanent deletion. Partial
 * outcomes are reported exactly; one job failing never blocks the rest. A
 * finished job's archive can be moved to Trash while its originals remain,
 * returning the job to an editable state for another attempt.
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
  type ArchiveStatus,
  type JobHistoryEntry,
  type JobIntent,
  type OriginalsAction,
  present,
  type SavedJob,
} from "../shared/queue.js";
import type { JobAction, LogEvent, PlanData, VerifyReport } from "../shared/api.js";
import { optionsEqual, planAffectingChanged, type GuiOptions } from "../shared/spec.js";
import { errorInfo, type AppLog } from "./log.js";
import { reportChanged } from "./plan-review.js";
import { describeOriginalsRemoval, describeRemovalDone, trashConfirmed, type TrashResult } from "./trash-outcome.js";
import { message, sentences, type Message, type MessageValues } from "../shared/i18n/translate.js";
import type { MessageKey } from "../shared/i18n/catalogues.js";
import type { CommandAdmission } from "./command-admission.js";
import { isZipKitError, sameFile, type PathClaim, type PathClaims, type PathResource, type PathState, type RemovalCheck, type RemovalRefusal } from "zipkitsdk";

export type { TrashResult } from "./trash-outcome.js";

export interface EngineDeps {
  admission: CommandAdmission;
  effects: PathClaims;
  resources(paths: string[], signal: AbortSignal): Promise<PathResource[]>;
  /** What is at a path now: there with a comparable fingerprint (which file,
   *  its size and when it last changed), gone, or out of reach. */
  pathState(target: string, signal: AbortSignal): Promise<PathState>;
  /** Dry-run plan for the given inputs/options; progress events go to `onEvent`. */
  plan(inputs: string[], options: GuiOptions, signal: AbortSignal, onEvent: (e: LogEvent) => void): Promise<PlanData>;
  /** Write a planned archive; resolves to the byte count (or null if unknown). */
  write(plan: PlanData, signal: AbortSignal, onEvent: (e: LogEvent) => void,
    onPhysicalSettlement: (settlement: Promise<void>) => void): Promise<number | null>;
  /** Verify a written archive: every entry's CRC-32, and against its manifest
   *  when `checkMetadata`; resolves to the SDK's reportOk. */
  verify(output: string, signal: AbortSignal, onEvent: (e: LogEvent) => void, checkMetadata: boolean): Promise<boolean>;
  /** Verify a written archive on request: the verdict, the counts and the
   *  paths that disagree, for the job's review. */
  inspect(output: string, signal: AbortSignal, onEvent: (e: LogEvent) => void, checkMetadata: boolean): Promise<VerifyReport>;
  /** Every check before the originals are removed (the SDK's checkRemoval):
   *  the archive is not inside them, it verifies against its manifest, and a
   *  fresh scan of `inputs` under the job's options still matches it; `removed`
   *  are inputs already gone. */
  checkRemoval(
    output: string,
    inputs: string[],
    removed: string[],
    options: GuiOptions,
    signal: AbortSignal,
    onEvent: (e: LogEvent) => void,
  ): Promise<RemovalCheck>;
  /** Classify input paths on disk (dir/file/missing) for the job's `entries`. */
  classify(paths: string[]): Promise<InputEntry[]>;
  /** Move each path independently to the OS Trash and report the exact outcome.
   *  Bounded and cancellable like `plan`/`write`/`verify`: a path not yet started
   *  when `signal` aborts is reported in `failed` (kept); one whose Trash call was
   *  still running when `signal` aborted or its time ran out is reported in
   *  `unconfirmed`, because that call may still move it. */
  trash(paths: string[], signal: AbortSignal): Promise<TrashResult>;
  /** Delete each path permanently and report the exact outcome, in the same
   *  buckets as {@link trash}: `moved` holds what was deleted. */
  deleteOriginals(paths: string[], signal: AbortSignal): Promise<TrashResult>;
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
  /** Verify a finished job's archive on request and record the outcome. Throws
   *  when it could not be verified at all; the job's history says why. */
  verify(id: string): Promise<VerifyReport | null>;
  /** Look at a job's originals again, and a finished job's archive: note an
   *  original gone or out of reach, an archive changed, replaced or gone. */
  refresh(id: string): Promise<void>;
  getPlan(id: string): PlanData | null;
  restore(saved: SavedJob[]): void;
  /** True while a job is actually writing/verifying/trashing (not merely queued),
   *  including a finished job whose originals are being moved on request. */
  hasRunningJob(): boolean;
  /** For app quit: abort whatever job is running, stop draining any queued ones,
   *  and resolve only once the in-flight run has actually stopped, so quit can
   *  wait for the writer's own `abort()` to remove its temp file. Unbounded here;
   *  the quit sequence bounds its wait on this. */
  shutdown(): Promise<void>;
  beginQuit(): void;
  resume(): void;
}

interface Rec {
  job: Job;
  /** The held live plan (carries the writer's out-of-band instructions). */
  plan: PlanData | null;
  aborter: AbortController | null;
  planTimer?: ReturnType<typeof setTimeout>;
  /** The archive path from the most recent write that actually committed. */
  publishedOutput: string | null;
  publication: PathResource | null;
  /** The archive's state when ZipKit last wrote or verified it. */
  fingerprint: string | null;
  /** What the archive was known as before its drive went out of reach. */
  statusBeforeUnavailable?: ArchiveStatus;
  /** A Create accepted for the current plan; only its completion consumes it. */
  runAfterPlan: boolean;
}

/** The code of an SDK failure, or of the SDK host's own exit. Undefined for
 *  plain or Node errors, so a Node `code` like ENOENT is never mistaken for an
 *  SDK code. */
function errCode(err: unknown): string | undefined {
  if (isZipKitError(err)) return err.code;
  return (err as { code?: unknown } | null)?.code === "host.exited" ? "host.exited" : undefined;
}

/** The path a stalled volume stopped responding at. */
function stalledPath(err: unknown): string | undefined {
  return isZipKitError(err) && err.code === "io.stalled" ? err.subject : undefined;
}

/** The archive path of the source file a write found changed since the scan. */
function changedSourcePath(err: unknown): string | undefined {
  return isZipKitError(err) && err.code === "write.source-changed" ? err.subject : undefined;
}

/** Whether a stall struck while a finished archive was being published, so the
 *  archive may still appear once the stalled call completes. */
function stalledWhileCommitting(err: unknown): boolean {
  return stalledPath(err) !== undefined && isZipKitError(err) && err.effect === "unknown";
}

/** A failed write's job message: a source file that changed while it was read
 *  is named, so the user knows the archive was refused rather than broken, and a
 *  publication that stalled says the archive may still appear rather than that
 *  it could not be written (an unknown outcome is reported as unknown). */
function writeFailureMessage(err: unknown, output: string): Message {
  const changed = changedSourcePath(err);
  if (changed !== undefined) return message("job.sourceChanged", { path: changed });
  if (errCode(err) === "write.durability") return message("job.writeDurabilityFailed", { path: output });
  if (stalledWhileCommitting(err)) {
    return failureMessage(err, "job.writeUnconfirmed", { path: output });
  }
  return failureMessage(err, "job.writeFailed");
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

/** The message for a refused Trash; only the location sentence differs between
 *  a Move-to-Trash run and the command on a finished job. */
function refusalMessage(refusal: RemovalRefusal, insideKey: MessageKey): Message {
  switch (refusal.reason) {
    case "inside":
      return message(insideKey);
    case "verify-failed":
      return message("job.verifyFailed");
    case "replaced":
      return message("job.archiveReplaced");
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
      return failureMessage(refusal.error, ERRORED_KEYS[refusal.step]);
  }
}

/** A failed step's job message: the step's own sentence, led by the path that
 *  stopped responding when the failure was a stalled volume. */
function failureMessage(err: unknown, key: MessageKey, values?: MessageValues): Message {
  // The SDK host's process ended mid-job; most likely the folder needed more
  // memory than the computer could give it.
  if (errCode(err) === "host.exited") return sentences([message("error.hostExited"), message(key, values)]) ?? message(key, values);
  const path = stalledPath(err);
  if (path === undefined) return message(key, values);
  return sentences([message("error.stalled", { path }), message(key, values)]) ?? message(key, values);
}

/** Whether a plan found a folder it could not list. */
function scanIncomplete(plan: PlanData): boolean {
  return plan.findings.some((f) => f.rule === "entry.unlisted");
}

export function createQueueEngine(deps: EngineDeps): QueueEngine {
  const recs = new Map<string, Rec>();
  const order: string[] = [];
  /** Ids explicitly requested to run, in request order. */
  const pending: string[] = [];
  const stoppedPlanners = new Set<string>();
  let draining = false;

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
  /** Look at the archive this job wrote and record what is there: a change
   *  since ZipKit last wrote or verified it, another file in its place, nothing
   *  at all, or a drive that is not connected. Resolves to whether the archive
   *  can be acted on now (true when that could not be told). */
  async function observeArchive(rec: Rec, signal: AbortSignal): Promise<boolean> {
    const output = rec.publishedOutput;
    if (!output) return false;
    const state = await lookAt(rec, output, signal);
    if (rec.publishedOutput !== output || state === undefined) return true;
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
    if (state.kind === "gone") {
      archiveGone(rec, output, "gone");
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
  function archiveGone(rec: Rec, output: string, how: "gone" | "replaced"): void {
    const id = rec.job.id;
    rec.publishedOutput = null;
    rec.publication = null;
    rec.fingerprint = null;
    const entries = rec.job.entries;
    const originalsGone = entries
      ? entries.some((entry) => entry.kind === "missing")
      : rec.job.state === "done" && removesOriginals(rec.job.intent);
    deps.log.warn(how === "gone" ? "archive missing" : "archive replaced", { jobId: id, output, originalsGone });
    if (originalsGone) {
      set(rec, {
        archiveWritten: false,
        archiveStatus: "missing",
        actionResult: {
          severity: "error",
          message: message(how === "gone" ? "action.archiveMissingOriginalsGone" : "action.archiveReplacedOriginalsGone"),
        },
      });
      emit();
      return;
    }
    set(rec, { actionResult: { severity: "warning", message: message(how === "gone" ? "action.archiveMissing" : "action.archiveReplaced") } });
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
    rec.publication = null;
    rec.fingerprint = null;
    emit();
    void planJob(rec.job.id);
  }
  /** Record a verification that passed, against the archive as it stood when it began. */
  function markVerified(rec: Rec, fingerprint: string | null): void {
    if (fingerprint !== null) rec.fingerprint = fingerprint;
    set(rec, { archiveStatus: "verified" });
  }
  /** The commands on finished jobs that are still moving originals to Trash,
   *  so quit can wait for them as it waits for a run. */
  const actions = new Set<Promise<void>>();
  async function claimFiles(read: string[], change: string[], signal: AbortSignal): Promise<PathClaim> {
    const [reads, changes] = await Promise.all([deps.resources(read, signal), deps.resources(change, signal)]);
    signal.throwIfAborted();
    if (!deps.admission.accepting()) throw new Error("The app is shutting down");
    const claim = deps.effects.claim([
      ...reads.map((item) => ({ ...item, mode: "read" as const })),
      ...changes.map((item) => ({ ...item, mode: "change" as const })),
    ]);
    if (!claim) throw new Error("Another archive action still owns these files");
    return claim;
  }
  async function publicationCurrent(rec: Rec, output: string, signal: AbortSignal): Promise<boolean> {
    const current = (await deps.resources([output], signal))[0];
    return rec.publication?.identity !== null && rec.publication !== null &&
      current?.identity === rec.publication.identity;
  }
  function retainTrash(claim: PathClaim, result: TrashResult): void {
    if (result.unconfirmed.length > 0) claim.release(result.settlement ?? null);
  }

  /** Every check before the originals are removed, in order: the archive is
   *  still the one this job made, then the SDK's checks. Null when all pass. */
  async function checkBeforeTrash(
    rec: Rec,
    output: string,
    inputs: string[],
    signal: AbortSignal,
    onEvent: (e: LogEvent) => void,
    removed: string[] = [],
  ): Promise<RemovalRefusal | null> {
    const id = rec.job.id;
    set(rec, { originalsChanges: undefined });
    if (!(await publicationCurrent(rec, output, signal))) return { reason: "replaced" };
    let check: RemovalCheck;
    try {
      check = await deps.checkRemoval(output, inputs, removed, rec.job.options, signal, onEvent);
    } catch (error) {
      // The check as a whole ended, such as when the SDK host's process did,
      // which the recheck's message covers: the originals were not checked.
      check = { refusal: { reason: "error", step: "recheck", error }, verified: null };
    }
    if (check.verified) markVerified(rec, check.verified.fingerprint);
    const refusal = check.refusal;
    if (refusal === null) return null;
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
      case "replaced":
        deps.log.error("trash blocked: another file at the archive's path", { jobId: id, output });
        break;
    }
    return refusal;
  }

  /** A progress sink for one run of an action on a job: Create's fresh plan,
   *  write, verify and recheck share its one run, so Progress heads them once. */
  function progressFor(id: string, action: JobAction): (e: LogEvent) => void {
    return deps.progress(id, action);
  }

  /** Classify a job's inputs on disk and store the result as `entries`, so the
   *  label, the input list, and the originals-still-present check stay accurate.
   *  Best-effort: a classify failure leaves the prior entries rather than crashing. */
  async function classifyInputs(id: string): Promise<void> {
    if (!deps.admission.accepting()) return;
    const rec = recs.get(id);
    if (!rec) return;
    const inputs = rec.job.inputs;
    try {
      const entries = await deps.classify(inputs);
      const cur = recs.get(id);
      // Drop a stale result if the inputs changed while we were classifying.
      if (!deps.admission.accepting() || !cur || cur.job.inputs !== inputs) return;
      set(cur, { entries });
      emit();
    } catch (err) {
      deps.log.warn("input classification failed", { jobId: id, error: errorInfo(err) });
    }
  }

  /** Classify the job's inputs now, for a decision that must not rest on an
   *  older look. False when they could not be looked at. */
  async function freshEntries(rec: Rec): Promise<boolean> {
    try {
      set(rec, { entries: await deps.classify(rec.job.inputs) });
      emit();
      return true;
    } catch (err) {
      deps.log.warn("input classification failed", { jobId: rec.job.id, error: errorInfo(err) });
      return false;
    }
  }

  async function planJob(id: string): Promise<void> {
    if (!deps.admission.accepting()) return;
    const rec = recs.get(id);
    if (!rec) return;
    clearTimeout(rec.planTimer);
    rec.planTimer = undefined;
    // Supersede any in-flight plan for this job (rapid input/option edits can stack
    // re-plans), then mark THIS run as the current one. A run that is no longer
    // current discards its result, so a slow stale plan can never overwrite the
    // newest one's state — the staleness guard `classifyInputs` already has.
    rec.aborter?.abort();
    const aborter = new AbortController();
    rec.aborter = aborter;
    const current = (): boolean => recs.get(id) === rec && rec.aborter === aborter;
    set(rec, { state: "planning", message: undefined, actionResult: undefined, errorCode: undefined });
    emit();
    try {
      const plan = await deps.plan(rec.job.inputs, rec.job.options, aborter.signal, progressFor(id, "plan"));
      if (!current()) return; // a newer plan superseded this one — discard the result
      rec.plan = plan;
      set(rec, {
        output: plan.output,
        summary: plan.summary,
        writable: plan.writable,
        scanIncomplete: scanIncomplete(plan),
        state: plan.writable ? "ready" : "needs-attention",
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
      if (!current()) return; // superseded (often via the abort above) — discard
      rec.plan = null;
      set(rec, {
        state: "needs-attention",
        writable: false,
        scanIncomplete: undefined,
        message: failureMessage(err, "job.prepareFailed"),
        errorCode: errCode(err),
      });
      deps.log.error("job plan failed", { jobId: id, error: errorInfo(err) });
    } finally {
      // Only the current run owns the aborter and the post-plan emit; a superseded
      // run leaves both to the newer plan it was replaced by.
      if (current()) {
        rec.aborter = null;
        emit();
        // If a run was requested while this plan was in flight, act on it now.
        maybeRunPending(id);
      }
    }
  }

  /** Re-plan fresh and write the archive. Resolves to the written output, or
   *  null when the job stopped (its state already says why). */
  async function writeStage(
    rec: Rec,
    signal: AbortSignal,
    onEvent: (e: LogEvent) => void,
  ): Promise<{ output: string; bytes: number | null; claim: PathClaim } | null> {
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
        message: failureMessage(err, "job.prepareFailed"),
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
    let settlement: Promise<void> | undefined;
    let claim: PathClaim;
    const removing = removesOriginals(rec.job.intent);
    try { claim = await claimFiles(removing ? [] : rec.job.inputs,
      removing ? [plan.output, ...rec.job.inputs] : [plan.output], signal); }
    catch (error) {
      set(rec, { state: "failed", message: message("job.writeFailed") });
      deps.log.error("job files could not be reserved", { jobId: id, error: errorInfo(error) });
      return null;
    }
    rec.publishedOutput = null;
    rec.publication = null;
    set(rec, { archiveWritten: false });
    try {
      bytes = await deps.write(plan, signal, onEvent, (physical) => { settlement = physical; });
    } catch (err) {
      claim.release(settlement ?? (stalledWhileCommitting(err) ? (err as { settlement?: Promise<void> }).settlement ?? null : undefined));
      set(rec, { state: "failed", message: writeFailureMessage(err, plan.output) });
      deps.log.error("job write failed", { jobId: id, error: errorInfo(err) });
      return null;
    }
    rec.publishedOutput = plan.output;
    const written = await lookAt(rec, plan.output, signal);
    rec.fingerprint = written?.kind === "present" ? written.fingerprint : null;
    set(rec, { archiveWritten: true, archiveStatus: "written", ...(bytes === null ? {} : { archiveBytes: bytes }) });
    try { rec.publication = (await deps.resources([plan.output], signal))[0] ?? null; }
    catch (error) { deps.log.warn("archive publication identity unavailable", { jobId: id, error: errorInfo(error) }); }
    return { output: plan.output, bytes, claim };
  }

  async function runJob(id: string): Promise<void> {
    const rec = recs.get(id);
    if (!rec) return;
    const intent = rec.job.intent;
    const removal: RemovalMethod | null = intent.originals === "keep" ? null : intent.originals;
    // A run that removes its originals and failed after its archive was written
    // resumes there: the archive stays, and the checks and the removal run again
    // for the inputs still present (a partial removal already took the others).
    const resumeFrom = removal ? rec.publishedOutput : null;
    rec.aborter = new AbortController();
    const signal = rec.aborter.signal;
    const onEvent = progressFor(id, "create");
    set(rec, { state: "running", message: undefined, actionResult: undefined, errorCode: undefined });
    emit();
    deps.log.info(resumeFrom ? "job run resumed after its write" : "job run started", {
      jobId: id,
      verify: intent.verify,
      originals: intent.originals,
    });
    let claim: PathClaim | undefined;
    try {
      let output: string;
      let inputs = rec.job.inputs;
      if (resumeFrom) {
        output = resumeFrom;
        claim = await claimFiles([output], rec.job.inputs, signal);
        let entries: InputEntry[];
        try {
          entries = await deps.classify(rec.job.inputs);
        } catch (err) {
          set(rec, { state: "failed", message: failureMessage(err, "job.prepareFailed") });
          deps.log.error("job resume could not classify inputs", { jobId: id, error: errorInfo(err) });
          return;
        }
        set(rec, { entries });
        inputs = entries.filter((e) => e.kind !== "missing").map((e) => e.path);
      } else {
        const written = await writeStage(rec, signal, onEvent);
        if (!written) return;
        claim = written.claim;
        output = written.output;
        if (!removal) {
          await finishKept(rec, output, written.bytes, signal, onEvent);
          return;
        }
      }

      // The originals leave: every check, then Trash or deletion — kept on any failure.
      if (!removal) return; // a run that keeps them finished above
      const gone = rec.job.inputs.filter((p) => !inputs.includes(p));
      const refusal = await checkBeforeTrash(rec, output, inputs, signal, onEvent, gone);
      if (refusal) {
        const again = resumeFrom !== null && refusal.reason === "verify-failed";
        set(rec, {
          state: "failed",
          message: again ? message("job.verifyFailedAgain") : refusalMessage(refusal, "job.insideSource"),
        });
        return;
      }
      let removed: TrashResult;
      try {
        removed = await (removal === "trash" ? deps.trash : deps.deleteOriginals)(inputs, signal);
        retainTrash(claim!, removed);
      } catch (err) {
        set(rec, { state: "failed", message: message(removal === "trash" ? "job.trashFailed" : "job.deleteFailed") });
        deps.log.error("job removal of the originals failed after verify", { jobId: id, method: removal, error: errorInfo(err) });
        return;
      }
      if (!trashConfirmed(removed)) {
        set(rec, {
          state: "failed",
          message: message("job.savedVerifiedPartial", { detail: describeOriginalsRemoval(removed, removal) }),
        });
        deps.log.error("job removal of the originals not fully confirmed after verify", { jobId: id, method: removal, ...removed });
        void classifyInputs(id);
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
      void classifyInputs(id);
    } catch (error) {
      set(rec, { state: "failed", message: failureMessage(error, removal === "delete" ? "job.deleteFailed" : "job.trashFailed") });
      deps.log.error("job archive action failed", { jobId: id, error: errorInfo(error) });
    } finally {
      claim?.release();
      rec.aborter = null;
      emit();
    }
  }

  /** A run that keeps its originals: done once written, or once verified when
   *  the user chose to verify. A failed verification keeps the archive, which
   *  the job then offers to reveal or move to Trash. */
  async function finishKept(rec: Rec, output: string, bytes: number | null, signal: AbortSignal, onEvent: (e: LogEvent) => void): Promise<void> {
    const id = rec.job.id;
    if (!rec.job.intent.verify) {
      set(rec, { state: "done", message: bytes === null ? message("job.savedShort") : message("job.saved", { size: { bytes } }) });
      deps.log.info("job saved", { jobId: id, output, bytes });
      return;
    }
    let verified: boolean;
    const seen: PathState | undefined = rec.fingerprint === null ? undefined : { kind: "present", fingerprint: rec.fingerprint };
    try {
      verified = await deps.verify(output, signal, onEvent, rec.job.options.metadata);
    } catch (err) {
      set(rec, { state: "failed", message: failureMessage(err, "job.savedVerifyErrored") });
      deps.log.error("job saved; verification errored", { jobId: id, output, error: errorInfo(err) });
      return;
    }
    if (!verified) {
      set(rec, { state: "failed", message: message("job.savedNotVerified") });
      deps.log.error("job saved; verification failed", { jobId: id, output });
      return;
    }
    markVerified(rec, seen?.kind === "present" ? seen.fingerprint : null);
    set(rec, { state: "done", message: bytes === null ? message("job.savedVerifiedShort") : message("job.savedVerified", { size: { bytes } }) });
    deps.log.info("job saved and verified", { jobId: id, output, bytes });
  }

  /** A job is runnable from the pending queue when it is writable-and-waiting
   *  (`ready`, or `needs-attention` only for review of a still-writable plan),
   *  waiting its turn (`queued`), or a retryable terminal (`failed`). Anything
   *  else in `pending` (e.g. re-planned to a blocked `needs-attention`) is skipped. */
  function isRunnable(job: Job): boolean {
    if (job.state === "needs-attention") return job.writable === true;
    return job.state === "ready" || job.state === "queued" || job.state === "failed";
  }

  /** Whether a job may not run at all: a Move-to-Trash job without the
   *  manifest it is verified against, or one whose plan could not list a
   *  folder. Checked when a run is requested and again when the drain reaches
   *  it, so neither a stale click nor an edit while it waited can start it. */
  function refusesRun(rec: Rec): boolean {
    if (manifestRequiredButMissing(rec.job.intent, rec.job.options.metadata)) {
      deps.log.warn("job run refused: removing the originals needs the manifest", { jobId: rec.job.id });
      return true;
    }
    if (scanBlocksRemoval(rec.job)) {
      deps.log.warn("job run refused: a folder could not be listed", { jobId: rec.job.id });
      return true;
    }
    return false;
  }

  /** The in-flight `runJob` call, if any — at most one at a time by design.
   *  `shutdown()` awaits this rather than the cancel request itself, so quit
   *  waits for the writer to actually stop. */
  let currentRun: Promise<void> | null = null;

  // Drain the explicit run requests one at a time (never two writes at once).
  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        if (!deps.admission.accepting()) break;
        const id = pending.shift();
        if (id === undefined) break;
        const rec = recs.get(id);
        // Skip if removed or no longer runnable (e.g. re-planned to needs-attention).
        if (!rec || !isRunnable(rec.job) || refusesRun(rec)) continue;
        currentRun = runJob(id);
        try {
          await currentRun;
        } finally {
          currentRun = null;
        }
      }
    } finally {
      draining = false;
    }
  }

  /** Start a run now, or — if another job is mid-run — mark it `queued` and let the
   *  drain pick it up in turn (so the wait is visible, not a silent `ready`). The
   *  caller has already placed the id in `pending`. */
  function startOrQueue(rec: Rec): void {
    if (draining) {
      set(rec, { state: "queued", message: undefined, actionResult: undefined, errorCode: undefined });
      emit();
    }
    void drain();
  }

  /** Honor a run that was requested while the job was still (re)planning: once the
   *  plan lands, run it if it became runnable, else drop the now-stale request.
   *  Called from planJob's tail. Without this, a run requested during the brief
   *  re-plan a field edit triggers (e.g. committing a file name, then Create) would
   *  be dropped by `run`'s state guard and silently do nothing. */
  function maybeRunPending(id: string): void {
    const rec = recs.get(id);
    if (!rec?.runAfterPlan) return;
    rec.runAfterPlan = false;
    if (rec.job.state === "ready" || rec.job.state === "failed") {
      pending.push(id);
      startOrQueue(rec);
    }
  }

  function changeInputs(rec: Rec, inputs: string[]): void {
    rec.runAfterPlan = false;
    set(rec, { inputs });
    deps.log.info("job inputs changed", { jobId: rec.job.id, inputs: inputs.length });
    void classifyInputs(rec.job.id);
    void planJob(rec.job.id);
  }

  function stopQueue(drainEdits: boolean): void {
    if (drainEdits) deps.admission.beginClosing(); else deps.admission.close();
    pending.length = 0;
    for (const rec of recs.values()) {
      rec.runAfterPlan = false;
      if (rec.job.state === "planning") stoppedPlanners.add(rec.job.id);
      clearTimeout(rec.planTimer);
      rec.planTimer = undefined;
      if (rec.job.state === "queued") set(rec, { state: "ready" });
      rec.aborter?.abort();
      if (rec.job.state === "planning") rec.aborter = null;
    }
    emit();
  }

  return {
    snapshot,
    add(inputs, options, intent = SAFEST_INTENT) {
      if (!deps.admission.accepting()) throw new Error("The app is shutting down");
      const id = deps.newId();
      recs.set(id, { job: { id, inputs, options, intent, state: "planning" }, plan: null, aborter: null, publishedOutput: null, publication: null, fingerprint: null, runAfterPlan: false });
      order.push(id);
      deps.log.info("job added", { jobId: id, inputs: inputs.length });
      emit();
      void classifyInputs(id);
      void planJob(id);
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
      // A Create accepted while planning describes the settings at that click.
      // Later edits must not turn a save request into an unconfirmed Trash run.
      if ((patch.intent !== undefined && !sameIntent(patch.intent, rec.job.intent)) ||
          (patch.options !== undefined && !optionsEqual(patch.options, rec.job.options))) rec.runAfterPlan = false;
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
        // Accept options now; quit captures them without waiting for a scan.
        // Retire the old controller immediately, before the replacement starts:
        // an abort-ignoring old plan must not publish during this delay.
        clearTimeout(rec.planTimer);
        rec.aborter?.abort();
        rec.aborter = null;
        rec.plan = null;
        set(rec, { state: "planning", writable: false, message: undefined, actionResult: undefined, errorCode: undefined });
        rec.planTimer = setTimeout(() => { void planJob(id); }, 250);
        emit();
      } else emit();
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
      if (!rec || rec.job.state === "running" || rec.job.trashing) return;
      clearTimeout(rec.planTimer);
      rec.aborter?.abort();
      recs.delete(id);
      const i = order.indexOf(id);
      if (i >= 0) order.splice(i, 1);
      const p = pending.indexOf(id);
      if (p >= 0) pending.splice(p, 1);
      deps.log.info("job removed", { jobId: id });
      emit();
    },
    cancel(id) {
      const rec = recs.get(id);
      if (!rec) return;
      rec.runAfterPlan = false;
      if (rec.planTimer !== undefined) {
        clearTimeout(rec.planTimer);
        rec.planTimer = undefined;
        set(rec, { state: "needs-attention", writable: false });
        emit();
        return;
      }
      // A `queued` job is only waiting its turn — it has no in-flight work to
      // abort. Drop it from the run queue and re-plan, so it returns to an
      // editable, freshly-evaluated state (the world may have changed while it
      // waited) instead of silently running later.
      if (rec.job.state === "queued") {
        const p = pending.indexOf(id);
        if (p >= 0) pending.splice(p, 1);
        deps.log.info("queued job cancelled", { jobId: id });
        void planJob(id);
        return;
      }
      if (!rec.aborter) return;
      deps.log.info("job cancel requested", { jobId: id, state: rec.job.state });
      rec.aborter.abort();
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
      // change) or one still (re)planning — the latter is honored when its plan
      // lands (maybeRunPending), which keeps "edit a field, then Create" from
      // being dropped mid-re-plan.
      if (s !== "planning" && !(s !== "queued" && isRunnable(rec.job))) return;
      // A failed job whose archive is being moved to Trash waits for that to end.
      if (rec.job.trashing) return;
      if (refusesRun(rec)) return;
      if (s === "planning") rec.runAfterPlan = true;
      else if (!pending.includes(id)) pending.push(id);
      deps.log.info("job run requested", { jobId: id, state: s });
      // A planning job waits for its plan; only a runnable one starts (or queues
      // behind a running job, so the wait is visible rather than a silent `ready`).
      if (s !== "planning") startOrQueue(rec);
    },
    removeArchive(id) {
      if (!deps.admission.accepting()) throw new Error("The app is shutting down");
      const rec = recs.get(id);
      if (!rec || !rec.publishedOutput) return;
      // One Trash action in flight per job, the same claim the originals take:
      // taken here, before the first await, so a second click, Retry, Move
      // originals or removing the job all wait for this one to end.
      if (!archiveRemovable(rec.job) || rec.job.trashing) return;
      const output = rec.publishedOutput;
      const aborter = new AbortController();
      rec.aborter = aborter;
      set(rec, { trashing: true, actionResult: undefined });
      emit();
      deps.log.info("remove archive requested", { jobId: id, output });
      const work = (async () => {
        let removed = false;
        let claim: PathClaim | undefined;
        try {
          claim = await claimFiles([], [output], aborter.signal);
          if (!(await observeArchive(rec, aborter.signal))) return;
          // The originals are looked at again: the archive may be all that is
          // left of any that went since the job was last looked at.
          if (!(await freshEntries(rec)) || !archiveRemovable(rec.job)) {
            set(rec, { actionResult: { severity: "error", message: message("action.archiveKept") } });
            deps.log.warn("archive removal refused: originals gone or out of reach", { jobId: id, output });
            return;
          }
          if (!(await publicationCurrent(rec, output, aborter.signal))) {
            set(rec, { actionResult: { severity: "error", message: message("job.archiveReplaced") } });
            deps.log.warn("archive removal refused: publication was replaced", { jobId: id, output });
            return;
          }
          // Cancel, and quit, stop the wait, not the OS call: an archive the
          // wait was cut short on is reported as possibly reaching Trash.
          const result = await deps.trash([output], aborter.signal);
          retainTrash(claim, result);
          if (result.unconfirmed.length > 0) {
            set(rec, {
              actionResult: {
                severity: "warning",
                message: message("action.archiveTrashUnconfirmed"),
              },
            });
            deps.log.warn("remove archive unconfirmed", { jobId: id, output, cancelled: aborter.signal.aborted });
          } else if (result.failed.length > 0) {
            set(rec, {
              actionResult: {
                severity: "error",
                message: message("action.archiveTrashFailed"),
              },
            });
            deps.log.error("remove archive failed", { jobId: id, failed: result.failed });
          } else {
            removed = true;
          }
        } catch (err) {
          set(rec, {
            actionResult: {
              severity: "error",
              message: message("action.archiveTrashFailed"),
            },
          });
          deps.log.error("remove archive failed", { jobId: id, error: errorInfo(err) });
        } finally {
          claim?.release();
          if (rec.aborter === aborter) rec.aborter = null;
          set(rec, { trashing: false });
          emit();
        }
        if (!removed) return;
        deps.log.info("archive removed", { jobId: id, output });
        set(rec, { actionResult: { severity: "info", message: message("action.archiveTrashed") } });
        resetForRecreate(rec);
      })();
      actions.add(work);
      void work.finally(() => actions.delete(work));
    },
    removeOriginals(id, method) {
      if (!deps.admission.accepting()) throw new Error("The app is shutting down");
      const rec = recs.get(id);
      const trash = method === "trash";
      // One in flight per job: the claim is taken here, before the first await.
      // A job that removed its originals on its run offers this again only when
      // some were put back, say from the Trash.
      if (!rec || rec.job.state !== "done" || rec.job.trashing) return;
      // Offered only when the archive carries the manifest its verify needs,
      // and when the scan listed every folder, so nothing unarchived is removed.
      if (!rec.job.options.metadata) {
        deps.log.warn("removing originals refused: the archive has no manifest", { jobId: id, method });
        return;
      }
      if (rec.job.scanIncomplete) {
        deps.log.warn("removing originals refused: a folder could not be listed", { jobId: id, method });
        return;
      }
      const output = rec.publishedOutput;
      const aborter = new AbortController();
      rec.aborter = aborter;
      set(rec, { trashing: true, actionResult: undefined });
      emit();
      deps.log.info("removing originals requested", { jobId: id, method, count: rec.job.inputs.length });
      const work = (async () => {
        // Null when the archive turned out to be gone: that already says so.
        let result: NonNullable<Job["actionResult"]> | null;
        let claim: PathClaim | undefined;
        try {
          if (!output) {
            result = { severity: "error", message: message("action.noArchive") };
          } else if (!(await observeArchive(rec, aborter.signal))) {
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
            const gone = rec.job.entries!.filter((entry) => entry.kind === "missing").map((entry) => entry.path);
            claim = await claimFiles([output], inputs, aborter.signal);
            const refusal = await checkBeforeTrash(rec, output, inputs, aborter.signal, progressFor(id, method), gone);
            if (aborter.signal.aborted) {
              result = { severity: "warning", message: message(trash ? "action.originalsTrashCancelled" : "action.originalsDeleteCancelled") };
              deps.log.info("removing originals cancelled", { jobId: id, method });
            } else if (refusal) {
              result = { severity: "error", message: refusalMessage(refusal, "action.archiveInsideOriginal") };
            } else {
              const removed = await (trash ? deps.trash : deps.deleteOriginals)(inputs, aborter.signal);
              retainTrash(claim, removed);
              if (trashConfirmed(removed)) {
                result = { severity: "info", message: describeRemovalDone(removed, method, "action", gone.length) };
                deps.log.info(trash ? "originals trashed" : "originals deleted", { jobId: id, count: removed.moved.length, gone: gone.length + (removed.gone?.length ?? 0) });
              } else {
                result = { severity: "error", message: describeOriginalsRemoval(removed, method) };
                deps.log.error("removing originals not fully confirmed", { jobId: id, method, ...removed });
              }
            }
          }
        } catch (err) {
          result = { severity: "error", message: message(trash ? "action.originalsTrashFailed" : "action.originalsDeleteFailed") };
          deps.log.error("removing originals failed", { jobId: id, method, error: errorInfo(err) });
        } finally { claim?.release(); }
        if (rec.aborter === aborter) rec.aborter = null;
        set(rec, result ? { trashing: false, actionResult: result } : { trashing: false });
        emit();
        // Re-classify so removed originals read as missing and the commands hide.
        void classifyInputs(id);
      })();
      actions.add(work);
      void work.finally(() => actions.delete(work));
    },
    async verify(id) {
      if (!deps.admission.accepting()) throw new Error("The app is shutting down");
      const rec = recs.get(id);
      const output = rec?.publishedOutput;
      if (!rec || !output || rec.job.trashing || rec.job.state === "running" || rec.job.state === "queued") return null;
      deps.log.info("verify requested", { jobId: id, output });
      const signal = new AbortController().signal;
      const work = (async (): Promise<VerifyReport | null> => {
        let claim: PathClaim | undefined;
        try {
          if (!(await observeArchive(rec, signal))) return null;
          claim = await claimFiles([output], [], signal);
          const seen = await lookAt(rec, output, signal);
          const report = await deps.inspect(output, signal, deps.progress(id, "verify"), rec.job.options.metadata);
          if (report.reportOk) {
            markVerified(rec, seen?.kind === "present" ? seen.fingerprint : null);
            set(rec, { actionResult: { severity: "info", message: message("history.verified", { count: report.summary.total }) } });
          } else {
            const s = report.summary;
            const problems = s.crcFailed + s.shaMismatched + s.manifestMismatched + report.missing.length + report.extra.length;
            set(rec, {
              archiveStatus: rec.job.archiveStatus === "verified" ? "changed" : rec.job.archiveStatus,
              actionResult: { severity: "error", message: message("history.verifyFailed", { count: Math.max(problems, 1) }) },
            });
          }
          deps.log.info("verify done", { jobId: id, output, reportOk: report.reportOk });
          return report;
        } catch (err) {
          deps.log.error("verify failed", { jobId: id, output, error: errorInfo(err) });
          set(rec, { actionResult: { severity: "error", message: failureMessage(err, "action.verifyErrored") } });
          throw err;
        } finally {
          claim?.release();
          emit();
        }
      })();
      const tracked = work.then(() => {}, () => {});
      actions.add(tracked);
      void tracked.finally(() => actions.delete(tracked));
      return work;
    },
    async refresh(id) {
      const rec = recs.get(id);
      if (!rec || rec.job.trashing) return;
      const state = rec.job.state;
      if (state === "running" || state === "queued" || state === "planning") return;
      await classifyInputs(id);
      if ((state === "done" || state === "failed") && rec.publishedOutput) await observeArchive(rec, new AbortController().signal);
    },
    getPlan(id) {
      return recs.get(id)?.plan ?? null;
    },
    restore(saved) {
      for (const s of saved) {
        recs.set(s.id, { job: { ...s, intent: SAFEST_INTENT, state: "planning" }, plan: null, aborter: null, publishedOutput: null, publication: null, fingerprint: null, runAfterPlan: false });
        order.push(s.id);
      }
      if (saved.length > 0) emit();
      for (const s of saved) {
        void classifyInputs(s.id);
        void planJob(s.id);
      }
    },
    hasRunningJob() {
      for (const rec of recs.values()) if (rec.job.state === "running" || rec.job.trashing) return true;
      return false;
    },
    async shutdown() {
      stopQueue(false);
      await Promise.allSettled([...(currentRun ? [currentRun] : []), ...actions]);
    },
    beginQuit() { stopQueue(true); },
    resume() {
      if (deps.admission.accepting()) return;
      deps.admission.reopen();
      for (const rec of recs.values()) if (rec.job.state === "planning") stoppedPlanners.add(rec.job.id);
      for (const id of stoppedPlanners) void planJob(id);
      stoppedPlanners.clear();
      emit();
      void drain();
    },
  };
}
