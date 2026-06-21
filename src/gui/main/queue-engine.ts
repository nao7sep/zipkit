/**
 * The queue engine: the job records and the state machine that drives them.
 * Plans each job in the background on add (non-blocking — never waiting on a
 * running write). Jobs are run one at a time, but only on explicit request: the
 * user creates a specific job's archive, the engine serializes the requests, and
 * runs each (write -> for the destructive intent, verify -> Trash) all-or-nothing,
 * keeping the originals on any failure. One job failing never blocks the rest.
 * A finished `save` job's archive can be removed, returning the job to an editable
 * state for another attempt.
 *
 * This is GUI-side orchestration — when to call which capability — not archive
 * logic: every verdict it acts on (`writable`, the verify result) comes from the
 * SDK. The SDK, OS Trash, persistence, event forwarding, and id minting arrive as
 * injected deps, so the engine is Electron-free and unit-testable with fakes. SDK
 * progress events are tagged with the originating job's id before they are
 * forwarded, so the renderer can show each job its own Progress.
 */

import type { InputEntry, Job, JobIntent, SavedJob } from "../shared/queue.js";
import type { GuiLogEvent, LogEvent, PlanData } from "../shared/api.js";
import { planAffectingChanged, type GuiOptions } from "../shared/spec.js";
import { outputInsideInputs } from "./safety.js";
import { errorInfo, type AppLog } from "./log.js";

export interface EngineDeps {
  /** Dry-run plan for the given inputs/options; progress events go to `onProgress`. */
  plan(inputs: string[], options: GuiOptions, signal: AbortSignal, onProgress: (e: LogEvent) => void): Promise<PlanData>;
  /** Write a planned archive; resolves to the byte count (or null if unknown). */
  write(plan: PlanData, signal: AbortSignal, onProgress: (e: LogEvent) => void): Promise<number | null>;
  /** Verify a written archive (CRC + metadata); resolves to the SDK's reportOk. */
  verify(output: string, signal: AbortSignal, onProgress: (e: LogEvent) => void): Promise<boolean>;
  /** Classify input paths on disk (dir/file/nonexistent) for the job's `entries`. */
  classify(paths: string[]): Promise<InputEntry[]>;
  /** Move the given paths to the OS Trash. */
  trash(paths: string[]): Promise<void>;
  /** Push the current job list to observers (renderer + persistence). */
  emit(jobs: Job[]): void;
  /** Forward one (job-tagged) progress event to the renderer. */
  sendEvent(event: GuiLogEvent): void;
  /** Mint a job id. */
  newId(): string;
  /** The app session log — one line per orchestration intent/outcome. */
  log: AppLog;
}

export interface QueueEngine {
  snapshot(): Job[];
  add(inputs: string[], options: GuiOptions, intent: JobIntent): string;
  update(id: string, patch: { options?: GuiOptions; intent?: JobIntent; inputs?: string[] }): void;
  remove(id: string): void;
  cancel(id: string): void;
  /** Request that a specific job's archive be created (or a failed one retried). */
  run(id: string): void;
  /** Trash a finished `save` job's archive and return it to an editable state. */
  removeArchive(id: string): void;
  /** Move a finished `save` job's originals to Trash on explicit, deliberate request. */
  trashOriginals(id: string): void;
  getPlan(id: string): PlanData | null;
  restore(saved: SavedJob[]): void;
}

interface Rec {
  job: Job;
  /** The held live plan (carries the writer's out-of-band instructions). */
  plan: PlanData | null;
  aborter: AbortController | null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

export function createQueueEngine(deps: EngineDeps): QueueEngine {
  const recs = new Map<string, Rec>();
  const order: string[] = [];
  /** Ids explicitly requested to run, in request order. */
  const pending: string[] = [];
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
  /** A progress sink that tags every SDK event with the running job's id. */
  function progressFor(id: string): (e: LogEvent) => void {
    return (e) => deps.sendEvent({ ...e, jobId: id });
  }

  /** Classify a job's inputs on disk and store the result as `entries`, so the
   *  label, the input list, and the originals-still-present check stay accurate.
   *  Best-effort: a classify failure leaves the prior entries rather than crashing. */
  async function classifyInputs(id: string): Promise<void> {
    const rec = recs.get(id);
    if (!rec) return;
    const inputs = rec.job.inputs;
    try {
      const entries = await deps.classify(inputs);
      const cur = recs.get(id);
      // Drop a stale result if the inputs changed while we were classifying.
      if (!cur || cur.job.inputs !== inputs) return;
      set(cur, { entries });
      emit();
    } catch (err) {
      deps.log.warn("input classification failed", { jobId: id, error: errorInfo(err) });
    }
  }

  async function planJob(id: string): Promise<void> {
    const rec = recs.get(id);
    if (!rec) return;
    // Supersede any in-flight plan for this job (rapid input/option edits can stack
    // re-plans), then mark THIS run as the current one. A run that is no longer
    // current discards its result, so a slow stale plan can never overwrite the
    // newest one's state — the staleness guard `classifyInputs` already has.
    rec.aborter?.abort();
    const aborter = new AbortController();
    rec.aborter = aborter;
    const current = (): boolean => recs.get(id) === rec && rec.aborter === aborter;
    set(rec, { state: "planning", message: undefined, errorCode: undefined });
    emit();
    try {
      const plan = await deps.plan(rec.job.inputs, rec.job.options, aborter.signal, progressFor(id));
      if (!current()) return; // a newer plan superseded this one — discard the result
      rec.plan = plan;
      set(rec, {
        output: plan.output,
        summary: plan.summary,
        writable: plan.writable,
        state: plan.writable ? "ready" : "needs-attention",
        message: plan.writable ? undefined : `${plan.summary.errors} blocking finding(s)`,
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
      set(rec, { state: "needs-attention", writable: false, message: errMsg(err), errorCode: errCode(err) });
      deps.log.error("job plan failed", { jobId: id, error: errorInfo(err) });
    } finally {
      // Only the current run owns the aborter and the post-plan emit; a superseded
      // run leaves both to the newer plan it was replaced by.
      if (current()) {
        rec.aborter = null;
        emit();
      }
    }
  }

  async function runJob(id: string): Promise<void> {
    const rec = recs.get(id);
    if (!rec) return;
    rec.aborter = new AbortController();
    const signal = rec.aborter.signal;
    const onProgress = progressFor(id);
    set(rec, { state: "running", message: undefined, errorCode: undefined });
    emit();
    deps.log.info("job run started", { jobId: id, intent: rec.job.intent });
    try {
      // Re-plan fresh: the world may have changed since this job was enqueued.
      let plan: PlanData;
      try {
        plan = await deps.plan(rec.job.inputs, rec.job.options, signal, onProgress);
        rec.plan = plan;
        set(rec, { output: plan.output, summary: plan.summary, writable: plan.writable });
      } catch (err) {
        set(rec, { state: "needs-attention", writable: false, message: errMsg(err), errorCode: errCode(err) });
        deps.log.error("job run re-plan failed", { jobId: id, error: errorInfo(err) });
        return;
      }
      if (!plan.writable) {
        set(rec, { state: "needs-attention", message: "no longer writable (re-checked at run)" });
        deps.log.warn("job run skipped: no longer writable", { jobId: id, errors: plan.summary.errors });
        return;
      }

      let bytes: number | null;
      try {
        bytes = await deps.write(plan, signal, onProgress);
      } catch (err) {
        set(rec, { state: "failed", message: `write failed: ${errMsg(err)}` });
        deps.log.error("job write failed", { jobId: id, error: errorInfo(err) });
        return;
      }

      if (rec.job.intent === "save") {
        set(rec, { state: "done", message: `saved (${bytes ?? 0} bytes)` });
        deps.log.info("job saved", { jobId: id, output: plan.output, bytes });
        return;
      }

      // archive-and-trash: guard, verify, then Trash — originals kept on any failure.
      if (outputInsideInputs(plan.output, rec.job.inputs)) {
        set(rec, { state: "failed", message: "archive is inside the source; originals untouched" });
        deps.log.error("job trash blocked: archive inside source", { jobId: id, output: plan.output });
        return;
      }
      try {
        if (!(await deps.verify(plan.output, signal, onProgress))) {
          set(rec, { state: "failed", message: "verification failed; originals kept" });
          deps.log.error("job verification failed; originals kept", { jobId: id, output: plan.output });
          return;
        }
      } catch (err) {
        set(rec, { state: "failed", message: `verification failed; originals kept: ${errMsg(err)}` });
        deps.log.error("job verification errored; originals kept", { jobId: id, error: errorInfo(err) });
        return;
      }
      try {
        await deps.trash(rec.job.inputs);
      } catch (err) {
        set(rec, { state: "failed", message: `saved & verified, but Trash failed: ${errMsg(err)}` });
        deps.log.error("job Trash failed after verify", { jobId: id, error: errorInfo(err) });
        return;
      }
      set(rec, { state: "done", message: `saved, verified, ${rec.job.inputs.length} moved to Trash` });
      deps.log.info("job archived and trashed", { jobId: id, output: plan.output, trashed: rec.job.inputs.length });
    } finally {
      rec.aborter = null;
      emit();
    }
  }

  // Drain the explicit run requests one at a time (never two writes at once).
  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const id = pending.shift();
        if (id === undefined) break;
        const rec = recs.get(id);
        // Skip if removed or no longer runnable (e.g. re-planned to needs-attention).
        if (!rec || (rec.job.state !== "ready" && rec.job.state !== "failed")) continue;
        await runJob(id);
      }
    } finally {
      draining = false;
    }
  }

  return {
    snapshot,
    add(inputs, options, intent) {
      const id = deps.newId();
      recs.set(id, { job: { id, inputs, options, intent, state: "planning" }, plan: null, aborter: null });
      order.push(id);
      deps.log.info("job added", { jobId: id, inputs: inputs.length, intent });
      emit();
      void classifyInputs(id);
      void planJob(id);
      return id;
    },
    update(id, patch) {
      const rec = recs.get(id);
      if (!rec || rec.job.state === "running") return;
      let replan = false;
      if (patch.intent !== undefined) {
        set(rec, { intent: patch.intent });
        deps.log.info("job intent set", { jobId: id, intent: patch.intent });
      }
      if (patch.inputs !== undefined) {
        set(rec, { inputs: patch.inputs });
        deps.log.info("job inputs changed", { jobId: id, inputs: patch.inputs.length });
        void classifyInputs(id);
        replan = true;
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
      if (replan) void planJob(id);
      else emit();
    },
    remove(id) {
      const rec = recs.get(id);
      if (!rec || rec.job.state === "running") return;
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
      if (!rec?.aborter) return;
      deps.log.info("job cancel requested", { jobId: id, state: rec.job.state });
      rec.aborter.abort();
    },
    run(id) {
      const rec = recs.get(id);
      if (!rec) return;
      if (rec.job.state !== "ready" && rec.job.state !== "failed") return;
      if (!pending.includes(id)) pending.push(id);
      deps.log.info("job run requested", { jobId: id, state: rec.job.state });
      void drain();
    },
    removeArchive(id) {
      const rec = recs.get(id);
      if (!rec || !rec.job.output) return;
      // Removable only when trashing the .zip cannot lose data: a done `save` job
      // (originals always kept), or a `failed` job whose write succeeded but a
      // later step failed (archive-and-trash keeps the originals on any failure).
      // A done archive-and-trash is NOT removable — its originals are already gone.
      const removable =
        (rec.job.state === "done" && rec.job.intent === "save") || rec.job.state === "failed";
      if (!removable) return;
      const output = rec.job.output;
      deps.log.info("remove archive requested", { jobId: id, output });
      void (async () => {
        try {
          await deps.trash([output]);
        } catch (err) {
          set(rec, { message: `could not remove the archive: ${errMsg(err)}` });
          deps.log.error("remove archive failed", { jobId: id, error: errorInfo(err) });
          emit();
          return;
        }
        // Back to an editable, re-planned job so options can be adjusted and the
        // archive created again.
        set(rec, { output: undefined, summary: undefined, writable: undefined, message: undefined });
        emit();
        void planJob(id);
      })();
    },
    trashOriginals(id) {
      const rec = recs.get(id);
      if (!rec || rec.job.state !== "done" || rec.job.intent !== "save") return;
      const inputs = rec.job.inputs;
      // Never trash an original that contains the archive — it would take the .zip too.
      if (rec.job.output && outputInsideInputs(rec.job.output, inputs)) {
        set(rec, { message: "the archive is inside an original; originals kept" });
        deps.log.error("trash originals blocked: archive inside source", {
          jobId: id,
          output: rec.job.output,
        });
        emit();
        return;
      }
      deps.log.info("trash originals requested", { jobId: id, count: inputs.length });
      void (async () => {
        try {
          await deps.trash(inputs);
        } catch (err) {
          set(rec, { message: `could not move the originals to Trash: ${errMsg(err)}` });
          deps.log.error("trash originals failed", { jobId: id, error: errorInfo(err) });
          emit();
          return;
        }
        set(rec, { message: `${inputs.length} moved to Trash` });
        deps.log.info("originals trashed", { jobId: id, count: inputs.length });
        emit();
        // Re-classify so the now-missing originals read as such and the command hides.
        void classifyInputs(id);
      })();
    },
    getPlan(id) {
      return recs.get(id)?.plan ?? null;
    },
    restore(saved) {
      for (const s of saved) {
        recs.set(s.id, { job: { ...s, state: "planning" }, plan: null, aborter: null });
        order.push(s.id);
      }
      if (saved.length > 0) emit();
      for (const s of saved) {
        void classifyInputs(s.id);
        void planJob(s.id);
      }
    },
  };
}
