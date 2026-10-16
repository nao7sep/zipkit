/**
 * The queue engine: the job records and the state machine that drives them.
 * Plans each job in the background on add (non-blocking — never waiting on a
 * running write). Jobs are run one at a time, but only on explicit request: the
 * user creates a specific job's archive, the engine serializes the requests, and
 * runs each (write -> for the destructive intent, verify -> per-item Trash).
 * Partial Trash outcomes are reported exactly; one job failing never blocks the rest.
 * A finished `save` job's archive can be removed, returning the job to an editable
 * state for another attempt.
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
  scanBlocksTrash,
  type InputEntry,
  type Job,
  type JobIntent,
  type SavedJob,
} from "../shared/queue.js";
import type { JobAction, LogEvent, PlanData, SourceComparison } from "../shared/api.js";
import { optionsEqual, planAffectingChanged, type GuiOptions } from "../shared/spec.js";
import { errorInfo, type AppLog } from "./log.js";
import { reportChanged } from "./plan-review.js";
import { describeOriginalsTrash, trashConfirmed, type TrashResult } from "./trash-outcome.js";
import { message, sentences, type Message, type MessageValues } from "../shared/i18n/translate.js";
import type { MessageKey } from "../shared/i18n/catalogues.js";
import type { CommandAdmission } from "./command-admission.js";
import { createArchiveEffects, type EffectClaim, type FileResource } from "./archive-effects.js";

export type { TrashResult } from "./trash-outcome.js";

export interface EngineDeps {
  admission: CommandAdmission;
  effects: ReturnType<typeof createArchiveEffects>;
  resources(paths: string[], signal: AbortSignal): Promise<FileResource[]>;
  /** Dry-run plan for the given inputs/options; progress events go to `onProgress`. */
  plan(inputs: string[], options: GuiOptions, signal: AbortSignal, onProgress: (e: LogEvent) => void): Promise<PlanData>;
  /** Write a planned archive; resolves to the byte count (or null if unknown). */
  write(plan: PlanData, signal: AbortSignal, onProgress: (e: LogEvent) => void,
    onPhysicalSettlement: (settlement: Promise<void>) => void): Promise<number | null>;
  /** Verify a written archive (CRC + metadata); resolves to the SDK's reportOk. */
  verify(output: string, signal: AbortSignal, onProgress: (e: LogEvent) => void): Promise<boolean>;
  /** Re-scan the inputs under the job's options and compare them with the
   *  archive's manifest: the last check before any of them goes to Trash. */
  recheck(
    output: string,
    inputs: string[],
    options: GuiOptions,
    signal: AbortSignal,
    onProgress: (e: LogEvent) => void,
  ): Promise<SourceComparison>;
  /** Classify input paths on disk (dir/file/nonexistent) for the job's `entries`. */
  classify(paths: string[]): Promise<InputEntry[]>;
  /** Move each path independently to the OS Trash and report the exact outcome.
   *  Bounded and cancellable like `plan`/`write`/`verify`: a path not yet started
   *  when `signal` aborts is reported in `failed` (kept); one whose Trash call was
   *  still running when `signal` aborted or its time ran out is reported in
   *  `unconfirmed`, because that call may still move it. */
  trash(paths: string[], signal: AbortSignal): Promise<TrashResult>;
  /** Physical-identity containment guard for every destructive action; bounded,
   *  and cancellable through `signal` when a job is waiting on it. */
  outputInsideInputs(output: string, inputs: string[], signal?: AbortSignal): Promise<boolean>;
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
export interface QueueEngine {
  snapshot(): Job[];
  add(inputs: string[], options: GuiOptions, intent: JobIntent): string;
  update(id: string, patch: { options?: GuiOptions; intent?: JobIntent }): void;
  addInputs(id: string, paths: string[]): InputAdmission;
  removeInput(id: string, path: string): void;
  remove(id: string): void;
  cancel(id: string): void;
  /** Request that a specific job's archive be created (or a failed one retried). */
  run(id: string, scope: RunScope): void;
  /** Trash a finished `save` job's archive and return it to an editable state. */
  removeArchive(id: string): void;
  /** Move a finished `save` job's originals to Trash on explicit, deliberate request. */
  trashOriginals(id: string): void;
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
  publication: FileResource | null;
  /** A Create accepted for the current plan; only its completion consumes it. */
  runAfterPlan: boolean;
}

/** The SDK error code for a thrown value, if it is a ZipKitError (carries both a
 *  dot-separated `code` and an `errorType`). Returns undefined for plain/Node
 *  errors, so a Node `code` like ENOENT is never mistaken for an SDK code. */
function errCode(err: unknown): string | undefined {
  if (err instanceof Error && typeof (err as { errorType?: unknown }).errorType === "string") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** The path a stalled volume stopped responding at, when the SDK reports one
 *  (a `stall` error names the operation's path). */
function stalledPath(err: unknown): string | undefined {
  if (err instanceof Error && (err as { errorType?: unknown }).errorType === "stall") {
    const path = (err as { path?: unknown }).path;
    if (typeof path === "string") return path;
  }
  return undefined;
}

/** The archive path of the source file a write found changed since the scan. */
function changedSourcePath(err: unknown): string | undefined {
  if (errCode(err) !== "write.source-changed") return undefined;
  const path = (err as { path?: unknown }).path;
  return typeof path === "string" ? path : undefined;
}

/** Whether a stall struck while a finished archive was being published, so the
 *  archive may still appear once the stalled call completes. */
function stalledWhileCommitting(err: unknown): boolean {
  return stalledPath(err) !== undefined && (err as { committing?: unknown }).committing === true;
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

/** Why the originals may not go to Trash, from {@link EngineDeps}' checks in
 *  order: the archive's location, its verify, and the recheck of the inputs. */
type TrashRefusal =
  | { reason: "inside" }
  | { reason: "location-error"; err: unknown }
  | { reason: "verify-failed" }
  | { reason: "verify-error"; err: unknown }
  | { reason: "changed"; comparison: SourceComparison }
  | { reason: "recheck-error"; err: unknown };

/** The message for a refused Trash; only the location sentence differs between
 *  a Move-to-Trash run and the command on a finished job. */
function refusalMessage(refusal: TrashRefusal, insideKey: MessageKey): Message {
  switch (refusal.reason) {
    case "inside":
      return message(insideKey);
    case "location-error":
      return failureMessage(refusal.err, "job.locationUnverified");
    case "verify-failed":
      return message("job.verifyFailed");
    case "verify-error":
      return failureMessage(refusal.err, "job.verifyErrored");
    case "changed":
      return message("job.originalsChanged");
    case "recheck-error":
      return failureMessage(refusal.err, "job.recheckErrored");
  }
}

/** An input's own name: the first segment of every manifest source path it
 *  contributed. */
function inputName(input: string): string {
  return input.split(/[\\/]/).filter((s) => s !== "").pop() ?? "";
}

/**
 * A recheck of only the inputs still present, after a partial Trash moved the
 * others: the manifest entries the moved inputs contributed are missing by
 * design, so they are not a difference. A moved input that shares its name
 * with one still present explains nothing, since their entries cannot be told
 * apart.
 */
function explainMoved(comparison: SourceComparison, present: string[], moved: string[]): SourceComparison {
  if (moved.length === 0) return comparison;
  const presentNames = new Set(present.map(inputName));
  const movedNames = new Set(moved.map(inputName).filter((name) => !presentNames.has(name)));
  const missing = comparison.missing.filter((p) => !movedNames.has(p.split("/")[0] ?? ""));
  const matches =
    comparison.added.length === 0 &&
    missing.length === 0 &&
    comparison.changed.length === 0 &&
    comparison.unlisted.length === 0;
  return { ...comparison, missing, matches };
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
  function set(rec: Rec, patch: Partial<Job>): void {
    rec.job = { ...rec.job, ...patch };
  }
  /** The commands on finished jobs that are still moving originals to Trash,
   *  so quit can wait for them as it waits for a run. */
  const actions = new Set<Promise<void>>();
  async function claimFiles(read: string[], change: string[], signal: AbortSignal): Promise<EffectClaim> {
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
  function retainTrash(claim: EffectClaim, result: TrashResult): void {
    if (result.unconfirmed.length > 0) claim.release(result.settlement ?? null);
  }

  /** Every check before the originals go to Trash, in order: the archive is
   *  not inside them, it verifies against its manifest, and a fresh scan of
   *  the inputs still matches that manifest. Null when all pass. */
  async function checkBeforeTrash(
    rec: Rec,
    output: string,
    inputs: string[],
    signal: AbortSignal,
    onProgress: (e: LogEvent) => void,
    moved: string[] = [],
  ): Promise<TrashRefusal | null> {
    const id = rec.job.id;
    if (!(await publicationCurrent(rec, output, signal))) return { reason: "verify-failed" };
    try {
      if (await deps.outputInsideInputs(output, inputs, signal)) {
        deps.log.error("trash blocked: archive inside source", { jobId: id, output });
        return { reason: "inside" };
      }
    } catch (err) {
      deps.log.error("trash blocked: physical identity check failed", { jobId: id, error: errorInfo(err) });
      return { reason: "location-error", err };
    }
    try {
      if (!(await deps.verify(output, signal, onProgress))) {
        deps.log.error("trash blocked: verification failed; originals kept", { jobId: id, output });
        return { reason: "verify-failed" };
      }
    } catch (err) {
      deps.log.error("trash blocked: verification errored; originals kept", { jobId: id, error: errorInfo(err) });
      return { reason: "verify-error", err };
    }
    try {
      const comparison = explainMoved(
        await deps.recheck(output, inputs, rec.job.options, signal, onProgress),
        inputs,
        moved,
      );
      if (!comparison.matches) {
        deps.log.error("trash blocked: originals changed since archiving", {
          jobId: id,
          added: comparison.added.length,
          missing: comparison.missing.length,
          changed: comparison.changed.length,
          unlisted: comparison.unlisted.length,
        });
        return { reason: "changed", comparison };
      }
    } catch (err) {
      deps.log.error("trash blocked: originals recheck errored", { jobId: id, error: errorInfo(err) });
      return { reason: "recheck-error", err };
    }
    return null;
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
    onProgress: (e: LogEvent) => void,
  ): Promise<{ output: string; bytes: number | null; claim: EffectClaim } | null> {
    const id = rec.job.id;
    // Re-plan fresh: the world may have changed since this job was enqueued.
    const reviewed = rec.plan;
    let plan: PlanData;
    try {
      plan = await deps.plan(rec.job.inputs, rec.job.options, signal, onProgress);
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
    let claim: EffectClaim;
    try { claim = await claimFiles(rec.job.intent === "save" ? rec.job.inputs : [],
      rec.job.intent === "save" ? [plan.output] : [plan.output, ...rec.job.inputs], signal); }
    catch (error) {
      set(rec, { state: "failed", message: message("job.writeFailed") });
      deps.log.error("job files could not be reserved", { jobId: id, error: errorInfo(error) });
      return null;
    }
    rec.publishedOutput = null;
    rec.publication = null;
    set(rec, { archiveWritten: false });
    try {
      bytes = await deps.write(plan, signal, onProgress, (physical) => { settlement = physical; });
    } catch (err) {
      claim.release(settlement ?? (stalledWhileCommitting(err) ? (err as { settlement?: Promise<void> }).settlement ?? null : undefined));
      set(rec, { state: "failed", message: writeFailureMessage(err, plan.output) });
      deps.log.error("job write failed", { jobId: id, error: errorInfo(err) });
      return null;
    }
    rec.publishedOutput = plan.output;
    set(rec, { archiveWritten: true });
    try { rec.publication = (await deps.resources([plan.output], signal))[0] ?? null; }
    catch (error) { deps.log.warn("archive publication identity unavailable", { jobId: id, error: errorInfo(error) }); }
    return { output: plan.output, bytes, claim };
  }

  async function runJob(id: string): Promise<void> {
    const rec = recs.get(id);
    if (!rec) return;
    // A Move-to-Trash run that failed after its archive was written resumes
    // there: the archive stays, and the checks and Trash run again for the
    // inputs still present (a partial Trash already moved the others).
    const resumeFrom = rec.job.intent === "archive-and-trash" ? rec.publishedOutput : null;
    rec.aborter = new AbortController();
    const signal = rec.aborter.signal;
    const onProgress = progressFor(id, "create");
    set(rec, { state: "running", message: undefined, actionResult: undefined, errorCode: undefined });
    emit();
    deps.log.info(resumeFrom ? "job run resumed after its write" : "job run started", {
      jobId: id,
      intent: rec.job.intent,
    });
    let claim: EffectClaim | undefined;
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
        inputs = entries.filter((e) => e.kind !== "nonexistent").map((e) => e.path);
      } else {
        const written = await writeStage(rec, signal, onProgress);
        if (!written) return;
        claim = written.claim;
        output = written.output;
        if (rec.job.intent === "save") {
          set(rec, { state: "done", message: message("job.saved", { count: written.bytes ?? 0 }) });
          deps.log.info("job saved", { jobId: id, output, bytes: written.bytes });
          return;
        }
      }

      // archive-and-trash: every check, then Trash — originals kept on any failure.
      const moved = rec.job.inputs.filter((p) => !inputs.includes(p));
      const refusal = await checkBeforeTrash(rec, output, inputs, signal, onProgress, moved);
      if (refusal) {
        const again = resumeFrom !== null && refusal.reason === "verify-failed";
        set(rec, {
          state: "failed",
          message: again ? message("job.verifyFailedAgain") : refusalMessage(refusal, "job.insideSource"),
        });
        return;
      }
      let trashResult: TrashResult;
      try {
        trashResult = await deps.trash(inputs, signal);
        retainTrash(claim!, trashResult);
      } catch (err) {
        set(rec, { state: "failed", message: message("job.trashFailed") });
        deps.log.error("job Trash failed after verify", { jobId: id, error: errorInfo(err) });
        return;
      }
      if (!trashConfirmed(trashResult)) {
        set(rec, {
          state: "failed",
          message: message("job.savedVerifiedPartial", { detail: describeOriginalsTrash(trashResult) }),
        });
        deps.log.error("job Trash not fully confirmed after verify", { jobId: id, ...trashResult });
        void classifyInputs(id);
        return;
      }
      set(rec, { state: "done", message: message("job.archivedAndTrashed", { count: inputs.length }) });
      deps.log.info("job archived and trashed", { jobId: id, output, trashed: inputs.length });
    } catch (error) {
      set(rec, { state: "failed", message: failureMessage(error, "job.trashFailed") });
      deps.log.error("job archive action failed", { jobId: id, error: errorInfo(error) });
    } finally {
      claim?.release();
      rec.aborter = null;
      emit();
    }
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
      deps.log.warn("job run refused: Move to Trash needs the manifest", { jobId: rec.job.id });
      return true;
    }
    if (scanBlocksTrash(rec.job)) {
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
    add(inputs, options, intent) {
      if (!deps.admission.accepting()) throw new Error("The app is shutting down");
      const id = deps.newId();
      recs.set(id, { job: { id, inputs, options, intent, state: "planning" }, plan: null, aborter: null, publishedOutput: null, publication: null, runAfterPlan: false });
      order.push(id);
      deps.log.info("job added", { jobId: id, inputs: inputs.length, intent });
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
      if ((patch.intent !== undefined && patch.intent !== rec.job.intent) ||
          (patch.options !== undefined && !optionsEqual(patch.options, rec.job.options))) rec.runAfterPlan = false;
      let replan = false;
      if (patch.intent !== undefined) {
        set(rec, { intent: patch.intent });
        deps.log.info("job intent set", { jobId: id, intent: patch.intent });
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
      if (rec && (!scope || scope.intent !== rec.job.intent ||
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
      // Removable only when trashing the .zip cannot lose data: a done `save` job
      // (originals always kept), or a `failed` job whose write succeeded but a
      // later step failed (any moved originals remain recoverable from Trash).
      // A done archive-and-trash is NOT removable — its originals are already gone.
      const removable =
        (rec.job.state === "done" && rec.job.intent === "save") || rec.job.state === "failed";
      // One Trash action in flight per job, the same claim the originals take:
      // taken here, before the first await, so a second click, Retry, Move
      // originals or removing the job all wait for this one to end.
      if (!removable || rec.job.trashing) return;
      const output = rec.publishedOutput;
      const aborter = new AbortController();
      rec.aborter = aborter;
      set(rec, { trashing: true, actionResult: undefined });
      emit();
      deps.log.info("remove archive requested", { jobId: id, output });
      const work = (async () => {
        let removed = false;
        let claim: EffectClaim | undefined;
        try {
          claim = await claimFiles([], [output], aborter.signal);
          if (!(await publicationCurrent(rec, output, aborter.signal))) {
            set(rec, { actionResult: { severity: "error", message: message("action.archiveTrashFailed") } });
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
        // Back to an editable, re-planned job so options can be adjusted and the
        // archive created again.
        set(rec, {
          output: undefined,
          summary: undefined,
          writable: undefined,
          message: undefined,
          actionResult: undefined,
          archiveWritten: false,
        });
        rec.publishedOutput = null;
        rec.publication = null;
        emit();
        void planJob(id);
      })();
      actions.add(work);
      void work.finally(() => actions.delete(work));
    },
    trashOriginals(id) {
      if (!deps.admission.accepting()) throw new Error("The app is shutting down");
      const rec = recs.get(id);
      // One in flight per job: the claim is taken here, before the first await.
      if (!rec || rec.job.state !== "done" || rec.job.intent !== "save" || rec.job.trashing) return;
      // Offered only when the archive carries the manifest its verify needs,
      // and when the scan listed every folder, so nothing unarchived is moved.
      if (!rec.job.options.metadata) {
        deps.log.warn("trash originals refused: the archive has no manifest", { jobId: id });
        return;
      }
      if (rec.job.scanIncomplete) {
        deps.log.warn("trash originals refused: a folder could not be listed", { jobId: id });
        return;
      }
      const inputs = rec.job.inputs;
      const output = rec.publishedOutput;
      const aborter = new AbortController();
      rec.aborter = aborter;
      set(rec, { trashing: true, actionResult: undefined });
      emit();
      deps.log.info("trash originals requested", { jobId: id, count: inputs.length });
      const work = (async () => {
        let result: NonNullable<Job["actionResult"]>;
        let claim: EffectClaim | undefined;
        try {
          if (!output) {
            result = { severity: "error", message: message("action.noArchive") };
          } else {
            claim = await claimFiles([output], inputs, aborter.signal);
            const refusal = await checkBeforeTrash(rec, output, inputs, aborter.signal, progressFor(id, "trash"));
            if (aborter.signal.aborted) {
              result = { severity: "warning", message: message("action.originalsTrashCancelled") };
              deps.log.info("trash originals cancelled", { jobId: id });
            } else if (refusal) {
              result = { severity: "error", message: refusalMessage(refusal, "action.archiveInsideOriginal") };
            } else {
              const trashResult = await deps.trash(inputs, aborter.signal);
              retainTrash(claim, trashResult);
              if (trashConfirmed(trashResult)) {
                result = { severity: "info", message: message("action.originalsTrashed", { count: inputs.length }) };
                deps.log.info("originals trashed", { jobId: id, count: inputs.length });
              } else {
                result = { severity: "error", message: describeOriginalsTrash(trashResult) };
                deps.log.error("trash originals not fully confirmed", { jobId: id, ...trashResult });
              }
            }
          }
        } catch (err) {
          result = { severity: "error", message: message("action.originalsTrashFailed") };
          deps.log.error("trash originals failed", { jobId: id, error: errorInfo(err) });
        } finally { claim?.release(); }
        if (rec.aborter === aborter) rec.aborter = null;
        set(rec, { trashing: false, actionResult: result });
        emit();
        // Re-classify so moved originals read as missing and the command hides.
        void classifyInputs(id);
      })();
      actions.add(work);
      void work.finally(() => actions.delete(work));
    },
    getPlan(id) {
      return recs.get(id)?.plan ?? null;
    },
    restore(saved) {
      for (const s of saved) {
        recs.set(s.id, { job: { ...s, state: "planning" }, plan: null, aborter: null, publishedOutput: null, publication: null, runAfterPlan: false });
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
