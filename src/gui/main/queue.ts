/**
 * Binds the queue engine to its real dependencies — the SDK verbs (with progress
 * forwarded to the renderer), the OS Trash, persistence, and id minting — and
 * registers the IPC handlers that delegate to it. The engine itself
 * (./queue-engine) is Electron-free and unit-tested with injected fakes; this
 * file is the wiring.
 */

import { ipcMain, shell } from "electron";
import { nanoid } from "nanoid";
import type { GuiOptions } from "../shared/spec.js";
import type { Job, JobIntent, SavedJob } from "../shared/queue.js";
import type { JobAction, LogEvent, PlanReport, ProgressCounts, VerifyResult } from "../shared/api.js";
import { toPlanReport } from "../shared/plan-report.js";
import { log, sendCounts, sendQueue, sendQueueSaved, startProgressRun, toGuiError } from "./runtime.js";
import { sdk } from "./sdk-process.js";
import { SdkHostError } from "./sdk-client.js";
import { createPathClaims, exportPlan, importPlan } from "zipkitsdk";
import { errorInfo } from "./log.js";
import { saveQueue, saveQueueWithin, toResumable } from "./persist.js";
import { createQueueEngine, type TrashResult } from "./queue-engine.js";
import { appAdmission } from "./command-admission.js";

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingJobs: SavedJob[] | undefined;
let saveChain: Promise<void> = Promise.resolve();

/** How long one path's Trash call may run before it is reported rather than
 *  awaited forever — `shell.trashItem` has no timeout or cancel of its own. */
const TRASH_TIMEOUT_MS = 10_000;

/** Move one path to the OS Trash, bounded by `TRASH_TIMEOUT_MS` and cancellable
 *  via `signal`. Neither condition stops the underlying OS call — Electron's API
 *  offers no way to do that — so a path the job stops waiting on resolves as
 *  `unconfirmed`: its move may still complete afterward, and it must never be
 *  reported as kept. Rejects only when the OS call itself fails. */
function trashPath(path: string, signal: AbortSignal): Promise<{ outcome: "moved" | "unconfirmed"; settlement: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const physical = shell.trashItem(path);
    const settlement = physical.then(() => {}, () => {});
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => finish(() => resolve({ outcome: "unconfirmed", settlement })), TRASH_TIMEOUT_MS);
    const onAbort = (): void => finish(() => resolve({ outcome: "unconfirmed", settlement }));
    signal.addEventListener("abort", onAbort);
    physical.then(
      () => finish(() => resolve({ outcome: "moved", settlement })),
      (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
}

// Every look at the user's files runs in the SDK host's utility process
// (./sdk-host); the engine supplies a job-tagging `onEvent`, so progress
// reaches the right job's Progress stream. A plan crosses each way packaged by
// the SDK's exportPlan, so it can still be written on the other side.
/** The call's own outcome, or "aborted" once `signal` aborts first. The call
 *  itself goes on; only the wait ends. */
function untilAborted<T>(call: Promise<T>, signal: AbortSignal): Promise<T | "aborted"> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    call.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The app's one set of path claims, shared by every job and command. */
const appPathClaims = createPathClaims();

// Each Progress sink belongs to one job; a call made with it sends that job's
// counts to the window, so the engine handles a run's sink and nothing more.
const sinkJobs = new WeakMap<(event: LogEvent) => void, string>();
function progressRun(jobId: string, action: JobAction): (event: LogEvent) => void {
  const sink = startProgressRun(jobId, action);
  sinkJobs.set(sink, jobId);
  return sink;
}
function countsFor(onEvent: (event: LogEvent) => void): ((counts: ProgressCounts) => void) | undefined {
  const jobId = sinkJobs.get(onEvent);
  return jobId === undefined ? undefined : (counts) => sendCounts(jobId, counts);
}

const engine = createQueueEngine({
  admission: appAdmission,
  effects: appPathClaims,
  resources: (paths, signal) => sdk.call("resources", [paths], { signal }),
  pathState: (target, signal) => sdk.call("pathState", [target], { signal }),
  inspect: (output, signal, onEvent, manifest) =>
    sdk.call("inspect", [output, manifest], { signal, onEvent, onProgress: countsFor(onEvent) }),
  plan: async (inputs, options, signal, onEvent) => importPlan(await sdk.call("plan", [inputs, options], { signal, onEvent })),
  write: (plan, signal, onEvent, onPhysicalSettlement) =>
    sdk.call("write", [exportPlan(plan)], { signal, onEvent, onPhysicalSettlement, onProgress: countsFor(onEvent) }),
  verify: (output, signal, onEvent, manifest) =>
    sdk.call("verify", [output, manifest], { signal, onEvent, onProgress: countsFor(onEvent) }),
  checkRemoval: async (output, inputs, removed, options, signal, onEvent) => {
    const check = await sdk.call("checkRemoval", [output, inputs, removed, options], { signal, onEvent, onProgress: countsFor(onEvent) });
    const refusal = check.refusal?.reason === "error" ? { ...check.refusal, error: new SdkHostError(check.refusal.error) } : check.refusal;
    return { ...check, refusal };
  },
  classify: (paths) => sdk.call("classify", [paths]),
  trash: async (paths, signal) => {
    const result: TrashResult = { moved: [], failed: [], unconfirmed: [], gone: [] };
    const settlements: Promise<void>[] = [];
    for (const p of paths) {
      if (signal.aborted) {
        result.failed.push({ path: p, message: "cancelled before Trash" });
        continue;
      }
      try {
        const moved = await trashPath(p, signal);
        settlements.push(moved.settlement);
        if (moved.outcome === "moved") result.moved.push(p);
        else result.unconfirmed.push(p);
      } catch (err) {
        // A path something else moved or deleted first is gone, not kept.
        let state;
        try { state = await sdk.call("pathState", [p]); } catch { state = undefined; }
        if (state?.kind === "missing") result.gone!.push(p);
        else result.failed.push({ path: p, message: err instanceof Error ? err.message : String(err) });
      }
    }
    result.settlement = Promise.all(settlements).then(() => {});
    return result;
  },
  // Each path is deleted in the SDK host, one at a time. A deletion still
  // running when the job stops waiting may yet finish, so it is reported as
  // unconfirmed, never as kept.
  deleteOriginals: async (paths, signal) => {
    const result: TrashResult = { moved: [], failed: [], unconfirmed: [], gone: [] };
    for (const p of paths) {
      if (signal.aborted) {
        result.failed.push({ path: p, message: "cancelled before deletion" });
        continue;
      }
      try {
        const outcome = await untilAborted(sdk.call("deletePath", [p]), signal);
        if (outcome === "aborted") result.unconfirmed.push(p);
        else result.moved.push(p);
      } catch (err) {
        if ((err as { code?: unknown }).code === "ENOENT") result.gone!.push(p);
        else result.failed.push({ path: p, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  },
  emit: (jobs) => {
    pendingJobs = toResumable(jobs);
    clearTimeout(saveTimer);
    // The window shows a failed save until a later save succeeds; the failed
    // snapshot stays pending, so the next change or quit tries it again.
    saveTimer = setTimeout(() => {
      void flushQueue().then(
        () => sendQueueSaved(true),
        (err) => {
          log.error("failed to persist the queue", { error: errorInfo(err) });
          sendQueueSaved(false);
        },
      );
    }, 500);
    sendQueue(jobs);
  },
  progress: progressRun,
  newId: () => nanoid(),
  log,
});

/** Persist the newest emitted resumable snapshot now. Used by the debounce and
 * every window/process shutdown path so an immediately closed window loses no
 * queue mutation. */
export async function flushQueue(): Promise<void> {
  for (;;) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    const jobs = pendingJobs;
    let joined: Promise<void>;
    if (jobs) {
      pendingJobs = undefined;
      const save = saveChain.catch(() => {}).then(() => saveQueue(jobs));
      saveChain = save;
      joined = save;
      try {
        await save;
      } catch (err) {
        // Keep a newer emitted snapshot if one arrived while this write was in
        // flight; otherwise retain this failed snapshot for the next flush attempt.
        pendingJobs ??= jobs;
        throw err;
      }
    } else {
      // A window-close flush may already have consumed pendingJobs while its
      // durable write is still running. Quit must join that same write rather
      // than treating the empty pending slot as proof that persistence finished.
      joined = saveChain;
      await joined;
    }

    // If another emission arrived while the joined save was in flight, fold it
    // into this flush too. Another concurrent flush may have consumed that
    // emission and extended saveChain already, so join the changed chain as well.
    if (!pendingJobs && saveChain === joined) return;
  }
}

/** Save the queue as it stands before returning, within `boundMs`, for the end of a Windows
 *  session, where nothing asynchronous runs after the handler returns. The debounced save it
 *  replaces would have written these same jobs. Throws when the save failed or did not finish. */
export function saveQueueBeforeSessionEnd(boundMs: number): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  saveQueueWithin(toResumable(engine.snapshot()), boundMs);
}

/** Re-plan the jobs startup loaded from the queue file, each one fresh. Startup
 *  loads the file before any window exists, so nothing the window does can save
 *  over an unreadable file before it is set aside. */
export function restoreQueue(saved: SavedJob[]): void {
  log.info("queue restored", { jobs: saved.length });
  engine.restore(saved);
}

/** Whether a job is actually writing/verifying/trashing right now — the
 *  question quit asks before it decides whether to confirm with the user. */
export function hasRunningJob(): boolean {
  return engine.hasRunningJob();
}

/** Cancel whatever job is running and wait for it to actually stop, for quit.
 *  A no-op when nothing is running. */
export async function cancelRunningJobAndWait(): Promise<void> {
  await engine.shutdown();
}
/** Close new effects and cancel active work before waiting for issued edits. */
export function beginQueueQuit(): void { engine.beginQuit(); }
export function resumeQueueAfterCancelledQuit(): void { engine.resume(); }

export function registerQueueIpc(): void {
  ipcMain.handle("zipkit:getQueue", async (): Promise<Job[]> => engine.snapshot());

  ipcMain.handle(
    "zipkit:addJob",
    async (_e, inputs: string[], options: GuiOptions): Promise<string> => engine.add(inputs, options),
  );

  ipcMain.handle(
    "zipkit:updateJob",
    async (
      _e,
      id: string,
      patch: { options?: GuiOptions; intent?: JobIntent },
    ): Promise<void> => engine.update(id, patch),
  );

  // Null when there was nothing to verify, such as an archive found gone; the
  // job's history says why.
  ipcMain.handle("zipkit:verify", async (_e, id: string): Promise<VerifyResult | null> => {
    try {
      const data = await engine.verify(id);
      return data ? { ok: true, data } : null;
    } catch (err) {
      return { ok: false, error: toGuiError(err) };
    }
  });
  ipcMain.handle("zipkit:refreshJob", async (_e, id: string): Promise<void> => engine.refresh(id));
  ipcMain.handle("zipkit:addJobInputs", async (_e, id: string, paths: string[]) => engine.addInputs(id, paths));
  ipcMain.handle("zipkit:removeJobInput", async (_e, id: string, path: string): Promise<void> => engine.removeInput(id, path));

  ipcMain.handle("zipkit:removeJob", async (_e, id: string): Promise<void> => engine.remove(id));

  ipcMain.handle("zipkit:runJob", async (_e, id: string, scope: { intent: JobIntent; inputs: string[] }): Promise<void> => engine.run(id, scope));

  ipcMain.handle("zipkit:removeArchive", async (_e, id: string): Promise<void> =>
    engine.removeArchive(id),
  );

  ipcMain.handle("zipkit:trashOriginals", async (_e, id: string): Promise<void> =>
    engine.removeOriginals(id, "trash"),
  );
  ipcMain.handle("zipkit:deleteOriginals", async (_e, id: string): Promise<void> =>
    engine.removeOriginals(id, "delete"),
  );

  ipcMain.handle("zipkit:cancelJob", async (_e, id: string): Promise<void> => engine.cancel(id));

  ipcMain.handle("zipkit:getPlan", async (_e, id: string): Promise<PlanReport | null> => {
    const plan = engine.getPlan(id);
    return plan ? toPlanReport(plan) : null;
  });
}
