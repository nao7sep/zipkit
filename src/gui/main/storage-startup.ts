import { Worker } from "node:worker_threads";

/** Bound startup on unavailable volumes; the worker owns all filesystem calls. */
export const STORAGE_PREPARE_WAIT_MS = 10_000;

export function prepareStorage(root: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = import.meta.url.endsWith(".ts") ? "./storage-worker.ts" : "./storage-worker.js";
    const worker = new Worker(new URL(file, import.meta.url), { workerData: { root } });
    const timer = setTimeout(() => fail(new Error("storage preparation timed out")), STORAGE_PREPARE_WAIT_MS);
    let settled = false;
    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => {});
      reject(error);
    }
    worker.once("error", fail);
    worker.once("exit", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(`storage preparation worker exited with code ${code}`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}
