/**
 * The queue engine: the job records and the state machine that drives them.
 * Plans each job in the background on add (non-blocking — never waiting on a
 * running write) and drains the ready jobs sequentially (one write at a time).
 * Each job is re-planned fresh at run time; a job no longer writable drops to
 * needs-attention rather than writing. The destructive intent runs
 * write -> verify -> Trash, all-or-nothing, keeping the originals on any
 * failure. One job failing never stops the drain.
 *
 * This is GUI-side orchestration — when to call which capability — not archive
 * logic: every verdict it acts on (`writable`, the verify result) comes from the
 * SDK. The SDK, OS Trash, persistence, and id minting arrive as injected deps,
 * so the engine is Electron-free and unit-testable with fakes.
 */

import type { Job, JobIntent, SavedJob } from "../shared/queue.js";
import type { PlanData } from "../shared/api.js";
import type { GuiOptions } from "../shared/spec.js";
import { outputInsideInputs } from "./safety.js";
import { errorInfo, type AppLog } from "./log.js";

export interface EngineDeps {
  /** Dry-run plan for the given inputs/options. */
  plan(inputs: string[], options: GuiOptions, signal: AbortSignal): Promise<PlanData>;
  /** Write a planned archive; resolves to the byte count (or null if unknown). */
  write(plan: PlanData, signal: AbortSignal): Promise<number | null>;
  /** Verify a written archive (CRC + metadata); resolves to the SDK's reportOk. */
  verify(output: string, signal: AbortSignal): Promise<boolean>;
  /** Move the given paths to the OS Trash. */
  trash(paths: string[]): Promise<void>;
  /** Push the current job list to observers (renderer + persistence). */
  emit(jobs: Job[]): void;
  /** Mint a job id. */
  newId(): string;
  /** The app session log — one line per orchestration intent/outcome. */
  log: AppLog;
}

export interface QueueEngine {
  snapshot(): Job[];
  add(inputs: string[], options: GuiOptions, intent: JobIntent): string;
  update(id: string, patch: { options?: GuiOptions; intent?: JobIntent }): void;
  remove(id: string): void;
  cancel(id: string): void;
  start(): void;
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

export function createQueueEngine(deps: EngineDeps): QueueEngine {
  const recs = new Map<string, Rec>();
  const order: string[] = [];
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

  async function planJob(id: string): Promise<void> {
    const rec = recs.get(id);
    if (!rec) return;
    rec.aborter = new AbortController();
    set(rec, { state: "planning", message: undefined });
    emit();
    try {
      const plan = await deps.plan(rec.job.inputs, rec.job.options, rec.aborter.signal);
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
      rec.plan = null;
      set(rec, { state: "needs-attention", writable: false, message: errMsg(err) });
      deps.log.error("job plan failed", { jobId: id, error: errorInfo(err) });
    } finally {
      rec.aborter = null;
      emit();
    }
  }

  async function runJob(id: string): Promise<void> {
    const rec = recs.get(id);
    if (!rec) return;
    rec.aborter = new AbortController();
    const signal = rec.aborter.signal;
    set(rec, { state: "running", message: undefined });
    emit();
    deps.log.info("job run started", { jobId: id, intent: rec.job.intent });
    try {
      // Re-plan fresh: the world may have changed since this job was enqueued.
      let plan: PlanData;
      try {
        plan = await deps.plan(rec.job.inputs, rec.job.options, signal);
        rec.plan = plan;
        set(rec, { output: plan.output, summary: plan.summary, writable: plan.writable });
      } catch (err) {
        set(rec, { state: "needs-attention", writable: false, message: errMsg(err) });
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
        bytes = await deps.write(plan, signal);
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
        if (!(await deps.verify(plan.output, signal))) {
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

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const next = order.map((id) => recs.get(id)).find((r) => r?.job.state === "ready");
        if (!next) break;
        await runJob(next.job.id);
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
      void planJob(id);
      return id;
    },
    update(id, patch) {
      const rec = recs.get(id);
      if (!rec || rec.job.state === "running") return;
      if (patch.intent !== undefined) set(rec, { intent: patch.intent });
      if (patch.options !== undefined) {
        set(rec, { options: patch.options });
        void planJob(id);
      } else {
        emit();
      }
    },
    remove(id) {
      const rec = recs.get(id);
      if (!rec || rec.job.state === "running") return;
      recs.delete(id);
      const i = order.indexOf(id);
      if (i >= 0) order.splice(i, 1);
      deps.log.info("job removed", { jobId: id });
      emit();
    },
    cancel(id) {
      const rec = recs.get(id);
      if (!rec?.aborter) return;
      deps.log.info("job cancel requested", { jobId: id, state: rec.job.state });
      rec.aborter.abort();
    },
    start() {
      deps.log.info("queue start requested", { ready: snapshot().filter((j) => j.state === "ready").length });
      void drain();
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
      for (const s of saved) void planJob(s.id);
    },
  };
}
