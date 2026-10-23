import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { prepareStorage, STORAGE_PREPARE_WAIT_MS } from "../../../src/gui/main/storage-startup.js";
const state = vi.hoisted(() => ({ workers: [] as Array<EventEmitter & { terminate: ReturnType<typeof vi.fn> }> }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 1);
    constructor(_file: URL, _options: unknown) { super(); state.workers.push(this); }
  } };
});
afterEach(() => { vi.useRealTimers(); state.workers.length = 0; });
it("waits for successful completion", async () => {
  const work = prepareStorage("/disposable/root");
  state.workers[0]!.emit("exit", 0);
  await expect(work).resolves.toBeUndefined();
  expect(state.workers[0]!.terminate).not.toHaveBeenCalled();
});
it.each(["error", "exit"])("rejects and terminates after worker %s", async (event) => {
  const work = prepareStorage("/disposable/root");
  const assertion = expect(work).rejects.toThrow();
  state.workers[0]!.emit(event, event === "error" ? new Error("unavailable") : 1);
  await assertion;
  expect(state.workers[0]!.terminate).toHaveBeenCalledOnce();
});
it("terminates and rejects an unavailable volume within the startup bound", async () => {
  vi.useFakeTimers();
  const work = prepareStorage("/disposable/root");
  const assertion = expect(work).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(STORAGE_PREPARE_WAIT_MS);
  await assertion;
  expect(state.workers[0]!.terminate).toHaveBeenCalledOnce();
});
