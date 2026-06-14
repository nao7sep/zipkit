/**
 * The queue engine. Owns the job records, plans them in the background on add
 * (non-blocking — never waiting on a running write), and drains the ready jobs
 * sequentially (one write at a time). Each job is re-planned fresh at run time;
 * a job no longer writable drops to needs-attention rather than writing. The
 * destructive intent runs write -> verify -> Trash, all-or-nothing, keeping the
 * originals on any failure. One job failing never stops the drain.
 *
 * This is GUI-side orchestration — when to call which SDK verb — not archive
 * logic: every verdict it acts on (`writable`, `reportOk`) comes from the SDK.
 */

import { randomUUID } from "node:crypto";
import { ipcMain, shell } from "electron";
import { buildSpec, type GuiOptions } from "../shared/spec.js";
import type { Job, JobIntent, PlanData } from "../shared/api.js";
import { forwardEvent, sendQueue, toGuiError, zip } from "./runtime.js";
import { outputInsideInputs } from "./safety.js";

interface Rec {
  job: Job;
  /** The held live plan (carries the writer's out-of-band instructions). */
  plan: PlanData | null;
  aborter: AbortController | null;
}

const recs = new Map<string, Rec>();
const order: string[] = [];
let draining = false;

function snapshot(): Job[] {
  return order.map((id) => recs.get(id)?.job).filter((j): j is Job => j !== undefined);
}
function emit(): void {
  sendQueue(snapshot());
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
    const plan = await zip.plan(buildSpec(rec.job.inputs, rec.job.options), {
      signal: rec.aborter.signal,
      onProgress: forwardEvent,
    });
    rec.plan = plan;
    set(rec, {
      output: plan.output,
      summary: plan.summary,
      writable: plan.writable,
      state: plan.writable ? "ready" : "needs-attention",
      message: plan.writable ? undefined : `${plan.summary.errors} blocking finding(s)`,
    });
  } catch (err) {
    rec.plan = null;
    set(rec, { state: "needs-attention", writable: false, message: toGuiError(err).message });
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
  try {
    // Re-plan fresh: the world may have changed since this job was enqueued.
    let plan: PlanData;
    try {
      plan = await zip.plan(buildSpec(rec.job.inputs, rec.job.options), { signal, onProgress: forwardEvent });
      rec.plan = plan;
      set(rec, { output: plan.output, summary: plan.summary, writable: plan.writable });
    } catch (err) {
      set(rec, { state: "needs-attention", writable: false, message: toGuiError(err).message });
      return;
    }
    if (!plan.writable) {
      set(rec, { state: "needs-attention", message: "no longer writable (re-checked at run)" });
      return;
    }

    let bytes: number | null;
    try {
      bytes = (await zip.write(plan, { signal, onProgress: forwardEvent })).bytes;
    } catch (err) {
      set(rec, { state: "failed", message: `write failed: ${toGuiError(err).message}` });
      return;
    }

    if (rec.job.intent === "save") {
      set(rec, { state: "done", message: `saved (${bytes ?? 0} bytes)` });
      return;
    }

    // archive-and-trash: guard, verify, then Trash — originals kept on any failure.
    if (outputInsideInputs(plan.output, rec.job.inputs)) {
      set(rec, { state: "failed", message: "archive is inside the source; originals untouched" });
      return;
    }
    try {
      const report = await zip.extract(
        { archive: plan.output, dryRun: true, checkMetadata: true },
        { signal, onProgress: forwardEvent },
      );
      if (!report.reportOk) {
        set(rec, { state: "failed", message: "verification failed; originals kept" });
        return;
      }
    } catch (err) {
      set(rec, { state: "failed", message: `verification failed; originals kept: ${toGuiError(err).message}` });
      return;
    }
    try {
      for (const input of rec.job.inputs) await shell.trashItem(input);
    } catch (err) {
      set(rec, { state: "failed", message: `saved & verified, but Trash failed: ${toGuiError(err).message}` });
      return;
    }
    set(rec, { state: "done", message: `saved, verified, ${rec.job.inputs.length} moved to Trash` });
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

export function registerQueueIpc(): void {
  ipcMain.handle(
    "zipkit:addJob",
    async (_e, inputs: string[], options: GuiOptions, intent: JobIntent): Promise<string> => {
      const id = randomUUID();
      recs.set(id, { job: { id, inputs, options, intent, state: "planning" }, plan: null, aborter: null });
      order.push(id);
      emit();
      void planJob(id);
      return id;
    },
  );

  ipcMain.handle(
    "zipkit:updateJob",
    async (_e, id: string, patch: { options?: GuiOptions; intent?: JobIntent }): Promise<void> => {
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
  );

  ipcMain.handle("zipkit:removeJob", async (_e, id: string): Promise<void> => {
    const rec = recs.get(id);
    if (!rec || rec.job.state === "running") return;
    recs.delete(id);
    const i = order.indexOf(id);
    if (i >= 0) order.splice(i, 1);
    emit();
  });

  ipcMain.handle("zipkit:startQueue", async (): Promise<void> => {
    void drain();
  });

  ipcMain.handle("zipkit:cancelJob", async (_e, id: string): Promise<void> => {
    recs.get(id)?.aborter?.abort();
  });

  ipcMain.handle("zipkit:getPlan", async (_e, id: string): Promise<PlanData | null> => recs.get(id)?.plan ?? null);
}
