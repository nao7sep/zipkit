/**
 * Binds the queue engine to its real dependencies — the SDK verbs (with progress
 * forwarded to the renderer), the OS Trash, permanent deletion, persistence,
 * and id minting — and
 * registers the IPC handlers that delegate to it. The engine itself
 * (./queue-engine) is Electron-free and unit-tested with injected fakes; this
 * file is the wiring.
 */

import { ipcMain, shell } from "electron";
import { nanoid } from "nanoid";
import type { GuiOptions } from "../shared/spec.js";
import type { JobIntent, SavedJob } from "../shared/queue.js";
import type { JobAction, LogEvent, PlanReport, ProgressCounts, VerifyResult } from "../shared/api.js";
import { toPlanReport } from "../shared/plan-report.js";
import { log, sendCounts, sendQueue, sendQueueSaved, startProgressRun, toGuiError } from "./runtime.js";
import { sdk } from "./sdk.js";
import { errorInfo } from "./log.js";
import { saveQueue, saveQueueWithin, toResumable } from "./persist.js";
import { createQueueEngine, type TrashResult } from "./queue-engine.js";
import { newestSave } from "./managedJson.js";
import { appAdmission } from "./command-admission.js";

// One queue save runs at a time, the newest job list waiting behind it.
const saves = newestSave(saveQueue);

/** Whether a failed removal left the path gone: something else moved or
 *  deleted it first, so it is reported as gone rather than kept. */
async function goneNow(target: string): Promise<boolean> {
  try { return (await sdk.pathState(target)).kind === "missing"; }
  catch { return false; }
}

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
  pathState: (target, signal) => sdk.pathState(target, { signal }),
  inspect: (output, signal, onEvent, manifestName) =>
    sdk.inspect(output, manifestName, { signal, onEvent, onProgress: countsFor(onEvent) }),
  plan: (inputs, options, signal, onEvent) => sdk.plan(inputs, options, { signal, onEvent }),
  write: (plan, signal, onEvent) => sdk.write(plan, { signal, onEvent, onProgress: countsFor(onEvent) }),
  verify: (output, signal, onEvent, manifestName) =>
    sdk.verify(output, manifestName, { signal, onEvent, onProgress: countsFor(onEvent) }),
  checkRemoval: (output, inputs, removed, options, signal, onEvent) =>
    sdk.checkRemoval(output, inputs, removed, options, { signal, onEvent, onProgress: countsFor(onEvent) }),
  pathKinds: (paths, signal) => sdk.pathKinds(paths, { signal }),
  // Each path goes to the OS Trash in turn, each call awaited to its end; a
  // cancel stops before the next path, never during a call.
  trash: async (paths, signal) => {
    const result: TrashResult = { moved: [], failed: [], gone: [] };
    for (const p of paths) {
      if (signal.aborted) {
        result.failed.push({ path: p, message: "cancelled before Trash" });
        continue;
      }
      try {
        await shell.trashItem(p);
        result.moved.push(p);
      } catch (err) {
        if (await goneNow(p)) result.gone!.push(p);
        else result.failed.push({ path: p, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  },
  // Each path is deleted for good in turn; a cancel stops before the next path.
  deleteOriginals: async (paths, signal) => {
    const result: TrashResult = { moved: [], failed: [], gone: [] };
    for (const p of paths) {
      if (signal.aborted) {
        result.failed.push({ path: p, message: "cancelled before deletion" });
        continue;
      }
      try {
        await sdk.deletePath(p);
        result.moved.push(p);
      } catch (err) {
        if ((err as { code?: unknown }).code === "ENOENT") result.gone!.push(p);
        else result.failed.push({ path: p, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  },
  emit: (jobs) => {
    // The window shows a failed save until a later save succeeds; the failed
    // job list stays waiting, so the next change or quit tries it again.
    saves.save(toResumable(jobs)).then(
      () => sendQueueSaved(true),
      (err) => {
        log.error("failed to persist the queue", { error: errorInfo(err) });
        sendQueueSaved(false);
      },
    );
    sendQueue(jobs);
  },
  progress: progressRun,
  newId: () => nanoid(),
  log,
});

/** Settle the queue saves asked for so far, writing a failed one again; for window close and
 *  quit. Rejects when the last write failed. */
export function flushQueue(): Promise<void> {
  return saves.flush();
}

/** Save the queue as it stands before returning, within `boundMs`, for the end of a Windows
 *  session, where nothing asynchronous runs after the handler returns. Throws when the save
 *  failed or did not finish. */
export function saveQueueBeforeSessionEnd(boundMs: number): void {
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
/** Close new effects and cancel active work; edits stay accepted. */
export function beginQueueQuit(): void { engine.beginQuit(); }
/** Stop taking job edits, as the quit's queue save begins. */
export function closeQueueEdits(): void { appAdmission.close(); }
export function resumeQueueAfterCancelledQuit(): void { engine.resume(); }

export function registerQueueIpc(): void {
  // A window subscribing gets the whole job list first; later changes follow it.
  ipcMain.on("zipkit:subscribeQueue", (event) => event.sender.send("zipkit:queue", engine.snapshot()));

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
