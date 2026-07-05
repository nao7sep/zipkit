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

let saveTimer: ReturnType<typeof setTimeout> | undefined;

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
    for (const p of paths) await shell.trashItem(p);
  },
  emit: (jobs) => {
    sendQueue(jobs);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void saveQueue(toResumable(jobs)).catch((err) =>
        log.error("failed to persist the queue", { error: errorInfo(err) }),
      );
    }, 500);
  },
  sendEvent,
  newId: () => nanoid(),
  log,
});

/** Reload the persisted jobs at launch and re-plan each one fresh. */
export async function restoreQueue(): Promise<void> {
  let saved: SavedJob[];
  try {
    saved = await loadQueue(log);
  } catch (err) {
    log.warn("could not load the saved queue; starting empty", { error: errorInfo(err) });
    saved = [];
  }
  log.info("queue restored", { jobs: saved.length });
  engine.restore(saved);
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
