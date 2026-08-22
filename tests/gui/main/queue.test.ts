import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadQueue: vi.fn(),
  saveQueue: vi.fn(),
  toResumable: vi.fn((jobs: unknown) => jobs),
  restore: vi.fn(),
  deps: undefined as undefined | { emit(jobs: unknown[]): void },
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  shell: { trashItem: vi.fn() },
}));
vi.mock("nanoid", () => ({ nanoid: () => "test-id" }));
vi.mock("../../../src/gui/main/persist.js", () => ({
  loadQueue: mocks.loadQueue,
  saveQueue: mocks.saveQueue,
  toResumable: mocks.toResumable,
}));
vi.mock("../../../src/gui/main/runtime.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sendEvent: vi.fn(),
  sendQueue: vi.fn(),
  zip: {},
}));
vi.mock("../../../src/gui/main/queue-engine.js", () => ({
  createQueueEngine: (deps: { emit(jobs: unknown[]): void }) => {
    mocks.deps = deps;
    return { restore: mocks.restore };
  },
}));
vi.mock("../../../src/gui/shared/spec.js", () => ({ buildSpec: vi.fn() }));
vi.mock("../../../src/gui/main/output.js", () => ({ resolveOutputPath: vi.fn() }));
vi.mock("../../../src/gui/main/inputs.js", () => ({ classifyPaths: vi.fn() }));

import { flushQueue, restoreQueue } from "../../../src/gui/main/queue.js";

describe("restoreQueue", () => {
  beforeEach(() => {
    mocks.loadQueue.mockReset();
    mocks.restore.mockReset();
    mocks.saveQueue.mockReset();
  });

  it("propagates a queue preservation failure instead of inventing an empty queue", async () => {
    const failure = new Error("EPERM: quarantine rename blocked");
    mocks.loadQueue.mockRejectedValue(failure);

    await expect(restoreQueue()).rejects.toBe(failure);
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("restores the value returned by the queue loader", async () => {
    const saved = [{ id: "a", inputs: ["/x"], options: {}, intent: "save" }];
    mocks.loadQueue.mockResolvedValue({ value: saved, quarantinedTo: null });

    await restoreQueue();

    expect(mocks.restore).toHaveBeenCalledWith(saved);
  });

  it("flushes the newest emitted snapshot before the debounce expires", async () => {
    const jobs = [{ id: "fresh" }];
    mocks.deps!.emit(jobs);
    await flushQueue();
    expect(mocks.toResumable).toHaveBeenCalledWith(jobs);
    expect(mocks.saveQueue).toHaveBeenCalledWith(jobs);
  });

  it("serializes overlapping flushes so an older write cannot land last", async () => {
    let releaseFirst!: () => void;
    mocks.saveQueue.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    const first = [{ id: "first" }];
    const second = [{ id: "second" }];
    mocks.deps!.emit(first);
    const firstFlush = flushQueue();
    mocks.deps!.emit(second);
    const secondFlush = flushQueue();
    await vi.waitFor(() => expect(mocks.saveQueue).toHaveBeenCalledTimes(1));
    releaseFirst();
    await Promise.all([firstFlush, secondFlush]);
    expect(mocks.saveQueue.mock.calls.map(([jobs]) => jobs)).toEqual([first, second]);
  });
});
