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
  trash: async (paths) => {
    const moved: string[] = [];
    const failed: Array<{ path: string; message: string }> = [];
    for (const p of paths) {
      try {
        await shell.trashItem(p);
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
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const jobs = pendingJobs;
  if (!jobs) return;
  pendingJobs = undefined;
  const save = saveChain.catch(() => {}).then(() => saveQueue(jobs));
  saveChain = save;
  try {
    await save;
  } catch (err) {
    // Keep a newer emitted snapshot if one arrived while this write was in
    // flight; otherwise retain this failed snapshot for the next flush attempt.
    pendingJobs ??= jobs;
    throw err;
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
