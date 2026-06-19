/**
 * Binds the queue engine to its real dependencies — the SDK verbs (with progress
 * forwarded to the renderer), the OS Trash, persistence, and id minting — and
 * registers the IPC handlers that delegate to it. The engine itself
 * (./queue-engine) is Electron-free and unit-tested with injected fakes; this
 * file is the wiring.
 */

import { randomUUID } from "node:crypto";
import { ipcMain, shell } from "electron";
import { buildSpec, type GuiOptions } from "../shared/spec.js";
import type { Job, JobIntent } from "../shared/queue.js";
import type { PlanData } from "../shared/api.js";
import { log, sendEvent, sendQueue, zip } from "./runtime.js";
import { loadQueue, saveQueue, toResumable } from "./persist.js";
import { resolveGuiOutput } from "./output.js";
import { createQueueEngine } from "./queue-engine.js";

let saveTimer: ReturnType<typeof setTimeout> | undefined;

const engine = createQueueEngine({
  // Absolutize (or reject) the typed output at the GUI boundary before it reaches
  // the SDK, so a relative output never resolves against the unpredictable
  // working directory. The SDK still infers an empty output beside the input.
  // The engine supplies a job-tagging `onProgress`, so progress reaches the right
  // job's activity stream.
  plan: (inputs, options, signal, onProgress) =>
    zip.plan(buildSpec(inputs, { ...options, output: resolveGuiOutput(options.output) }), {
      signal,
      onProgress,
    }),
  write: async (plan, signal, onProgress) => (await zip.write(plan, { signal, onProgress })).bytes,
  verify: async (output, signal, onProgress) =>
    (
      await zip.extract(
        { archive: output, dryRun: true, checkMetadata: true },
        { signal, onProgress },
      )
    ).reportOk,
  trash: async (paths) => {
    for (const p of paths) await shell.trashItem(p);
  },
  emit: (jobs) => {
    sendQueue(jobs);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveQueue(toResumable(jobs)), 500);
  },
  sendEvent,
  newId: () => randomUUID(),
  log,
});

/** Reload the persisted jobs at launch and re-plan each one fresh. */
export async function restoreQueue(): Promise<void> {
  const saved = await loadQueue();
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
    async (_e, id: string, patch: { options?: GuiOptions; intent?: JobIntent }): Promise<void> =>
      engine.update(id, patch),
  );

  ipcMain.handle("zipkit:removeJob", async (_e, id: string): Promise<void> => engine.remove(id));

  ipcMain.handle("zipkit:runJob", async (_e, id: string): Promise<void> => engine.run(id));

  ipcMain.handle("zipkit:removeArchive", async (_e, id: string): Promise<void> =>
    engine.removeArchive(id),
  );

  ipcMain.handle("zipkit:cancelJob", async (_e, id: string): Promise<void> => engine.cancel(id));

  ipcMain.handle("zipkit:getPlan", async (_e, id: string): Promise<PlanData | null> => engine.getPlan(id));
}
