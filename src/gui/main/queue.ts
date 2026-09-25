/**
 * Binds the queue engine to its real dependencies — the SDK verbs (with progress
 * forwarded to the renderer), the OS Trash, persistence, and id minting — and
 * registers the IPC handlers that delegate to it. The engine itself
 * (./queue-engine) is Electron-free and unit-tested with injected fakes; this
 * file is the wiring.
 */

import { ipcMain, shell } from "electron";
import { nanoid } from "nanoid";
import { buildSpec, type GuiOptions } from "../shared/spec.js";
import type { Job, JobIntent, SavedJob } from "../shared/queue.js";
import type { PlanData } from "../shared/api.js";
import { log, sendEvent, sendQueue, zip } from "./runtime.js";
import { errorInfo } from "./log.js";
import { loadQueue, saveQueue, toResumable } from "./persist.js";
import { resolveOutputPath } from "./output.js";
import { classifyPaths } from "./inputs.js";
import { createQueueEngine } from "./queue-engine.js";
import { outputInsideInputs } from "./safety.js";

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingJobs: SavedJob[] | undefined;
let saveChain: Promise<void> = Promise.resolve();

/** How long one path's Trash call may run before it is reported rather than
 *  awaited forever — `shell.trashItem` has no timeout or cancel of its own. */
const TRASH_TIMEOUT_MS = 10_000;

/** Move one path to the OS Trash, bounded by `TRASH_TIMEOUT_MS` and cancellable
 *  via `signal`. Neither condition stops the underlying OS call — Electron's API
 *  offers no way to do that — but the job stops waiting on it and moves on,
 *  reporting the path as not (confirmed) moved. */
function trashPath(path: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`could not confirm Trash for ${path} in time`))),
      TRASH_TIMEOUT_MS,
    );
    const onAbort = (): void => finish(() => reject(new Error("cancelled")));
    signal.addEventListener("abort", onAbort);
    shell.trashItem(path).then(
      () => finish(resolve),
      (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
}

const engine = createQueueEngine({
  // Compose the output path from the GUI's directory + file name at the boundary
  // (absolute, or empty so the SDK infers beside the input — never resolved
  // against the unpredictable working directory). The engine supplies a
  // job-tagging `onProgress`, so progress reaches the right job's Progress stream.
  plan: async (inputs, options, signal, onProgress) => {
    const spec = buildSpec(inputs, options);
    const output = await resolveOutputPath(options.outputDir, options.fileName, inputs);
    if (output) spec.output = output;
    return zip.plan(spec, { signal, onProgress });
  },
  write: async (plan, signal, onProgress) => (await zip.write(plan, { signal, onProgress })).bytes,
  verify: async (output, signal, onProgress) =>
    (
      await zip.extract(
        { archive: output, dryRun: true, checkMetadata: true },
        { signal, onProgress },
      )
    ).reportOk,
  classify: (paths) => classifyPaths(paths),
  trash: async (paths, signal) => {
    const moved: string[] = [];
    const failed: Array<{ path: string; message: string }> = [];
    for (const p of paths) {
      if (signal.aborted) {
        failed.push({ path: p, message: "cancelled before Trash" });
        continue;
      }
      try {
        await trashPath(p, signal);
        moved.push(p);
      } catch (err) {
        failed.push({ path: p, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return { moved, failed };
  },
  outputInsideInputs,
  emit: (jobs) => {
    pendingJobs = toResumable(jobs);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void flushQueue().catch((err) =>
        log.error("failed to persist the queue", { error: errorInfo(err) }),
      );
    }, 500);
    sendQueue(jobs);
  },
  sendEvent,
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

/** Reload the persisted jobs at launch and re-plan each one fresh. Returns where
 *  a corrupt queue file was set aside (null normally) so startup can report it. */
export async function restoreQueue(): Promise<string | null> {
  // Missing files and successfully quarantined corrupt files already resolve to
  // an empty queue inside loadQueue. Every rejection is therefore a real I/O or
  // preservation failure and must reach startup rather than being overwritten by
  // a later save from an invented empty queue.
  const { value: saved, quarantinedTo } = await loadQueue(log);
  log.info("queue restored", { jobs: saved.length });
  engine.restore(saved);
  return quarantinedTo;
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

export function registerQueueIpc(): void {
  ipcMain.handle("zipkit:getQueue", async (): Promise<Job[]> => engine.snapshot());

  ipcMain.handle(
    "zipkit:addJob",
    async (_e, inputs: string[], options: GuiOptions, intent: JobIntent): Promise<string> =>
      engine.add(inputs, options, intent),
  );

  ipcMain.handle(
    "zipkit:updateJob",
    async (
      _e,
      id: string,
      patch: { options?: GuiOptions; intent?: JobIntent; inputs?: string[] },
    ): Promise<void> => engine.update(id, patch),
  );

  ipcMain.handle("zipkit:removeJob", async (_e, id: string): Promise<void> => engine.remove(id));

  ipcMain.handle("zipkit:runJob", async (_e, id: string): Promise<void> => engine.run(id));

  ipcMain.handle("zipkit:removeArchive", async (_e, id: string): Promise<void> =>
    engine.removeArchive(id),
  );

  ipcMain.handle("zipkit:trashOriginals", async (_e, id: string): Promise<void> =>
    engine.trashOriginals(id),
  );

  ipcMain.handle("zipkit:cancelJob", async (_e, id: string): Promise<void> => engine.cancel(id));

  ipcMain.handle("zipkit:getPlan", async (_e, id: string): Promise<PlanData | null> => engine.getPlan(id));
}
