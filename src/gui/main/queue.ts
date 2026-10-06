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
import { log, sendQueue, sendQueueSaved, startProgressRun, zip } from "./runtime.js";
import { errorInfo } from "./log.js";
import { saveQueue, saveQueueWithin, toResumable } from "./persist.js";
import { resolveOutputPath } from "./output.js";
import { classifyPaths } from "./inputs.js";
import { createQueueEngine, type TrashResult } from "./queue-engine.js";
import { outputInsideInputs } from "./safety.js";

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
function trashPath(path: string, signal: AbortSignal): Promise<"moved" | "unconfirmed"> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => finish(() => resolve("unconfirmed")), TRASH_TIMEOUT_MS);
    const onAbort = (): void => finish(() => resolve("unconfirmed"));
    signal.addEventListener("abort", onAbort);
    shell.trashItem(path).then(
      () => finish(() => resolve("moved")),
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
    const output = await resolveOutputPath(options.outputDir, options.fileName, inputs, zip.volume(signal));
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
  // The archive is the output: naming it keeps the fresh scan from counting
  // the archive itself when it sits beside the inputs.
  recheck: (output, inputs, options, signal, onProgress) => {
    const spec = buildSpec(inputs, options);
    spec.output = output;
    return zip.compareSources(spec, output, { signal, onProgress });
  },
  classify: (paths) => classifyPaths(paths, zip.volume()),
  trash: async (paths, signal) => {
    const result: TrashResult = { moved: [], failed: [], unconfirmed: [] };
    for (const p of paths) {
      if (signal.aborted) {
        result.failed.push({ path: p, message: "cancelled before Trash" });
        continue;
      }
      try {
        if ((await trashPath(p, signal)) === "moved") result.moved.push(p);
        else result.unconfirmed.push(p);
      } catch (err) {
        result.failed.push({ path: p, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  },
  outputInsideInputs: (output, inputs, signal) => outputInsideInputs(output, inputs, zip.volume(signal)),
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
  progress: startProgressRun,
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
 *  loads the file before any window exists, so nothing
 *  the window does can save over a file this build must not write. */
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
