import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadQueue: vi.fn(),
  saveQueue: vi.fn(),
  toResumable: vi.fn((jobs: unknown) => jobs),
  restore: vi.fn(),
  deps: undefined as
    | undefined
    | {
        emit(jobs: unknown[]): void;
        trash(
          paths: string[],
          signal: AbortSignal,
        ): Promise<{ moved: string[]; failed: Array<{ path: string; message: string }>; unconfirmed: string[] }>;
      },
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
  createQueueEngine: (deps: {
    emit(jobs: unknown[]): void;
    trash(
      paths: string[],
      signal: AbortSignal,
    ): Promise<{ moved: string[]; failed: Array<{ path: string; message: string }>; unconfirmed: string[] }>;
  }) => {
    mocks.deps = deps;
    return { restore: mocks.restore };
  },
}));
vi.mock("../../../src/gui/shared/spec.js", () => ({ buildSpec: vi.fn() }));
vi.mock("../../../src/gui/main/output.js", () => ({ resolveOutputPath: vi.fn() }));
vi.mock("../../../src/gui/main/inputs.js", () => ({ classifyPaths: vi.fn() }));

import { shell } from "electron";
import { flushQueue, restoreQueue } from "../../../src/gui/main/queue.js";

const trashItem = vi.mocked(shell.trashItem);

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

  it("an empty overlapping flush still joins the in-flight durable save", async () => {
    let release!: () => void;
    mocks.saveQueue.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    mocks.deps!.emit([{ id: "closing" }]);

    const closeFlush = flushQueue();
    const quitFlush = flushQueue();
    let quitFinished = false;
    void quitFlush.then(() => { quitFinished = true; });
    await vi.waitFor(() => expect(mocks.saveQueue).toHaveBeenCalledTimes(1));
    expect(quitFinished).toBe(false);

    release();
    await Promise.all([closeFlush, quitFlush]);
    expect(quitFinished).toBe(true);
  });

  it("an overlapping flush follows a newer save consumed by the first flusher", async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    mocks.saveQueue
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseSecond = resolve; }));
    mocks.deps!.emit([{ id: "first" }]);
    const firstFlush = flushQueue();
    const quitFlush = flushQueue();
    let quitFinished = false;
    void quitFlush.then(() => { quitFinished = true; });
    await vi.waitFor(() => expect(mocks.saveQueue).toHaveBeenCalledTimes(1));
    mocks.deps!.emit([{ id: "newest" }]);

    releaseFirst();
    await vi.waitFor(() => expect(mocks.saveQueue).toHaveBeenCalledTimes(2));
    expect(quitFinished).toBe(false);

    releaseSecond();
    await Promise.all([firstFlush, quitFlush]);
    expect(quitFinished).toBe(true);
  });
});

describe("the trash dependency (ZK-1: bounded and cancellable)", () => {
  beforeEach(() => {
    trashItem.mockReset();
  });

  it("stops before a path once the signal is already aborted, never calling shell.trashItem for it", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await mocks.deps!.trash(["/a", "/b"], controller.signal);

    expect(trashItem).not.toHaveBeenCalled();
    expect(result).toEqual({
      moved: [],
      failed: [
        { path: "/a", message: "cancelled before Trash" },
        { path: "/b", message: "cancelled before Trash" },
      ],
      unconfirmed: [],
    });
  });

  it("reports a path whose Trash call never answers as unconfirmed, instead of waiting forever", async () => {
    vi.useFakeTimers();
    try {
      trashItem.mockReturnValue(new Promise(() => {})); // never settles
      const controller = new AbortController();

      const pending = mocks.deps!.trash(["/stuck"], controller.signal);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result).toEqual({ moved: [], failed: [], unconfirmed: ["/stuck"] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reports a timed-out path as kept, since its Trash call can still complete", async () => {
    vi.useFakeTimers();
    try {
      let completeLate!: () => void;
      trashItem.mockReturnValue(new Promise<void>((resolve) => { completeLate = resolve; }));

      const pending = mocks.deps!.trash(["/slow"], new AbortController().signal);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      completeLate(); // the OS finishes the move after the job stopped waiting

      expect(result.failed).toEqual([]);
      expect(result.unconfirmed).toEqual(["/slow"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting on a Trash call as soon as the signal aborts, reporting it unconfirmed", async () => {
    trashItem.mockReturnValue(new Promise(() => {})); // never settles on its own
    const controller = new AbortController();

    const pending = mocks.deps!.trash(["/a", "/b"], controller.signal);
    controller.abort();
    const result = await pending;

    expect(trashItem).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      moved: [],
      failed: [{ path: "/b", message: "cancelled before Trash" }],
      unconfirmed: ["/a"],
    });
  });

  it("reports a path the OS refuses to move as kept", async () => {
    trashItem.mockRejectedValue(new Error("permission denied"));

    const result = await mocks.deps!.trash(["/a"], new AbortController().signal);

    expect(result).toEqual({ moved: [], failed: [{ path: "/a", message: "permission denied" }], unconfirmed: [] });
  });

  it("moves every path that resolves before the signal aborts", async () => {
    trashItem.mockResolvedValue(undefined);

    const result = await mocks.deps!.trash(["/a", "/b"], new AbortController().signal);

    expect(trashItem).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ moved: ["/a", "/b"], failed: [], unconfirmed: [] });
  });
});
