import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveQueue: vi.fn(),
  saveQueueWithin: vi.fn(),
  snapshot: vi.fn((): unknown[] => []),
  toResumable: vi.fn((jobs: unknown) => jobs),
  restore: vi.fn(),
  sdkCall: vi.fn(),
  deps: undefined as
    | undefined
    | {
        emit(jobs: unknown[]): void;
        trash(
          paths: string[],
          signal: AbortSignal,
        ): Promise<{ moved: string[]; failed: Array<{ path: string; message: string }>; unconfirmed: string[]; gone?: string[] }>;
        deleteOriginals(
          paths: string[],
          signal: AbortSignal,
        ): Promise<{ moved: string[]; failed: Array<{ path: string; message: string }>; unconfirmed: string[]; gone?: string[] }>;
      },
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  shell: { trashItem: vi.fn() },
}));
vi.mock("nanoid", async (importOriginal) => ({ ...(await importOriginal<typeof import("nanoid")>()), nanoid: () => "test-id" }));
vi.mock("../../../src/gui/main/persist.js", () => ({
  saveQueue: mocks.saveQueue,
  saveQueueWithin: mocks.saveQueueWithin,
  toResumable: mocks.toResumable,
}));
vi.mock("../../../src/gui/main/runtime.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  startProgressRun: vi.fn(() => vi.fn()),
  sendQueue: vi.fn(),
}));
vi.mock("../../../src/gui/main/sdk-process.js", () => ({ sdk: { call: mocks.sdkCall } }));
vi.mock("../../../src/gui/main/queue-engine.js", () => ({
  createQueueEngine: (deps: {
    emit(jobs: unknown[]): void;
    trash(
      paths: string[],
      signal: AbortSignal,
    ): Promise<{ moved: string[]; failed: Array<{ path: string; message: string }>; unconfirmed: string[]; gone?: string[] }>;
    deleteOriginals(
      paths: string[],
      signal: AbortSignal,
    ): Promise<{ moved: string[]; failed: Array<{ path: string; message: string }>; unconfirmed: string[]; gone?: string[] }>;
  }) => {
    mocks.deps = deps;
    return { restore: mocks.restore, snapshot: mocks.snapshot };
  },
}));

import { shell } from "electron";
import { flushQueue, restoreQueue, saveQueueBeforeSessionEnd } from "../../../src/gui/main/queue.js";
import type { SavedJob } from "../../../src/gui/shared/queue.js";
import { SAVE } from "../../helpers/intents.js";

const trashItem = vi.mocked(shell.trashItem);

describe("restoreQueue", () => {
  beforeEach(() => {
    mocks.restore.mockReset();
    mocks.saveQueue.mockReset();
  });

  it("re-plans the jobs startup loaded", () => {
    const saved = [{ id: "a", inputs: ["/x"], options: {}, intent: SAVE }] as unknown as SavedJob[];

    restoreQueue(saved);

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

describe("saveQueueBeforeSessionEnd", () => {
  it("saves the jobs as they stand within the bound, in place of the pending debounced save", () => {
    vi.useFakeTimers();
    try {
      const jobs = [{ id: "running" }, { id: "queued" }];
      mocks.snapshot.mockReturnValueOnce(jobs);
      mocks.saveQueue.mockReset();
      mocks.deps!.emit(jobs);

      saveQueueBeforeSessionEnd(2_000);

      expect(mocks.saveQueueWithin).toHaveBeenCalledWith(jobs, 2_000);
      vi.advanceTimersByTime(1_000);
      expect(mocks.saveQueue).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
    expect({ moved: result.moved, failed: result.failed, unconfirmed: result.unconfirmed }).toEqual({
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

      expect({ moved: result.moved, failed: result.failed, unconfirmed: result.unconfirmed }).toEqual({ moved: [], failed: [], unconfirmed: ["/stuck"] });
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
    expect({ moved: result.moved, failed: result.failed, unconfirmed: result.unconfirmed }).toEqual({
      moved: [],
      failed: [{ path: "/b", message: "cancelled before Trash" }],
      unconfirmed: ["/a"],
    });
  });

  it("reports a path the OS refuses to move as kept", async () => {
    trashItem.mockRejectedValue(new Error("permission denied"));

    const result = await mocks.deps!.trash(["/a"], new AbortController().signal);

    expect({ moved: result.moved, failed: result.failed, unconfirmed: result.unconfirmed }).toEqual({ moved: [], failed: [{ path: "/a", message: "permission denied" }], unconfirmed: [] });
  });

  it("reports a path something else moved or deleted first as gone, not kept", async () => {
    trashItem.mockRejectedValue(new Error("no such file"));
    mocks.sdkCall.mockResolvedValueOnce({ kind: "missing" });

    const result = await mocks.deps!.trash(["/a"], new AbortController().signal);

    expect(mocks.sdkCall).toHaveBeenCalledWith("pathState", ["/a"]);
    expect({ moved: result.moved, failed: result.failed, gone: result.gone }).toEqual({ moved: [], failed: [], gone: ["/a"] });
  });

  it("reports an original already gone when deleted for good as gone, by the errno code the host forwards", async () => {
    const { SdkHostError } = await import("../../../src/gui/main/sdk-client.js");
    mocks.sdkCall.mockRejectedValueOnce(new SdkHostError({ name: "Error", message: "ENOENT: no such file", code: "ENOENT" }));

    const result = await mocks.deps!.deleteOriginals(["/a"], new AbortController().signal);

    expect({ moved: result.moved, failed: result.failed, gone: result.gone }).toEqual({ moved: [], failed: [], gone: ["/a"] });
  });

  it("moves every path that resolves before the signal aborts", async () => {
    trashItem.mockResolvedValue(undefined);

    const result = await mocks.deps!.trash(["/a", "/b"], new AbortController().signal);

    expect(trashItem).toHaveBeenCalledTimes(2);
    expect({ moved: result.moved, failed: result.failed, unconfirmed: result.unconfirmed }).toEqual({ moved: ["/a", "/b"], failed: [], unconfirmed: [] });
  });
});

describe("the SDK host wiring", () => {
  type Wired = {
    plan(inputs: string[], options: unknown, signal: AbortSignal, onEvent: () => void): Promise<object>;
    write(plan: object, signal: AbortSignal, onEvent: () => void, onSettlement: () => void): Promise<number | null>;
    verify(output: string, signal: AbortSignal, onEvent: () => void): Promise<boolean>;
    pathKinds(paths: string[]): Promise<unknown>;
  };
  const wired = () => mocks.deps as unknown as Wired;
  beforeEach(() => mocks.sdkCall.mockReset());

  it("passes the host's plan to the engine and back to be written, as plain data", async () => {
    const plan = { mode: "plan", output: "/out.zip", writable: true, instructions: { entries: [{ archivePath: "a" }] } };
    mocks.sdkCall.mockResolvedValueOnce(plan).mockResolvedValueOnce(42);
    const signal = new AbortController().signal;
    const onEvent = vi.fn();
    const planned = await wired().plan(["/in"], { level: 6 }, signal, onEvent);
    expect(mocks.sdkCall).toHaveBeenLastCalledWith("plan", [["/in"], { level: 6 }], { signal, onEvent });
    expect(planned).toBe(plan);
    const onSettlement = vi.fn();
    await expect(wired().write(planned, signal, onEvent, onSettlement)).resolves.toBe(42);
    expect(mocks.sdkCall).toHaveBeenLastCalledWith("write", [plan], { signal, onEvent, onPhysicalSettlement: onSettlement, onProgress: undefined });
  });

  it("asks the SDK host to verify and pathKinds", async () => {
    mocks.sdkCall.mockResolvedValueOnce(true).mockResolvedValueOnce([{ path: "/in", kind: "directory" }]);
    const signal = new AbortController().signal;
    await expect(wired().verify("/out.zip", signal, vi.fn())).resolves.toBe(true);
    await expect(wired().pathKinds(["/in"])).resolves.toEqual([{ path: "/in", kind: "directory" }]);
    expect(mocks.sdkCall.mock.calls.map(([op]) => op)).toEqual(["verify", "pathKinds"]);
  });
});

describe("the delete dependency", () => {
  type Deleting = { deleteOriginals(paths: string[], signal: AbortSignal): Promise<{ moved: string[]; failed: Array<{ path: string; message: string }>; unconfirmed: string[]; gone?: string[]; settlement: Promise<void> }> };
  const deleting = () => mocks.deps as unknown as Deleting;
  beforeEach(() => mocks.sdkCall.mockReset());

  it("deletes each path in the SDK host and reports each outcome", async () => {
    mocks.sdkCall.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("EACCES"));
    const result = await deleting().deleteOriginals(["/a", "/b"], new AbortController().signal);
    expect(mocks.sdkCall.mock.calls).toEqual([["deletePath", ["/a"]], ["deletePath", ["/b"]]]);
    expect(result).toMatchObject({ moved: ["/a"], failed: [{ path: "/b", message: "EACCES" }], unconfirmed: [], gone: [] });
  });

  it("reports a path already gone when its deletion came as gone, not kept", async () => {
    mocks.sdkCall.mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }));
    const result = await deleting().deleteOriginals(["/a"], new AbortController().signal);
    expect(result).toMatchObject({ moved: [], failed: [], unconfirmed: [], gone: ["/a"] });
  });

  it.each(["resolve", "reject"] as const)("retains cancellation settlement until the physical deletion %ss", async (outcome) => {
    vi.useFakeTimers();
    try {
      let resolvePhysical!: () => void;
      let rejectPhysical!: (error: Error) => void;
      const physical = new Promise<void>((resolve, reject) => { resolvePhysical = resolve; rejectPhysical = reject; });
      mocks.sdkCall.mockReturnValueOnce(physical);
      const controller = new AbortController();
      const pending = deleting().deleteOriginals(["/a", "/b"], controller.signal);
      expect(mocks.sdkCall.mock.calls).toEqual([["deletePath", ["/a"]]]);
      expect(vi.getTimerCount()).toBe(1);

      controller.abort();
      const result = await pending;
      expect(result).toMatchObject({ moved: [], failed: [{ path: "/b", message: "cancelled before deletion" }], unconfirmed: ["/a"], gone: [] });
      expect(vi.getTimerCount()).toBe(0);
      const settled = vi.fn();
      void result.settlement.then(settled);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();

      if (outcome === "resolve") resolvePhysical();
      else rejectPhysical(new Error("late physical failure"));
      await result.settlement;
      expect(settled).toHaveBeenCalledOnce();
      expect(mocks.sdkCall.mock.calls).toEqual([["deletePath", ["/a"]]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["resolve", "reject"] as const)("stops issuing deletions at timeout and retains settlement until the physical call %ss", async (outcome) => {
    vi.useFakeTimers();
    try {
      let resolvePhysical!: () => void;
      let rejectPhysical!: (error: Error) => void;
      const physical = new Promise<void>((resolve, reject) => { resolvePhysical = resolve; rejectPhysical = reject; });
      mocks.sdkCall.mockReturnValueOnce(physical);
      const pending = deleting().deleteOriginals(["/a", "/b"], new AbortController().signal);
      const returned = vi.fn();
      void pending.then(returned);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(returned).not.toHaveBeenCalled();
      expect(mocks.sdkCall.mock.calls).toEqual([["deletePath", ["/a"]]]);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result).toMatchObject({ moved: [], failed: [{ path: "/b", message: "cancelled before deletion" }], unconfirmed: ["/a"], gone: [] });
      expect(vi.getTimerCount()).toBe(0);
      const settled = vi.fn();
      void result.settlement.then(settled);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();

      if (outcome === "resolve") resolvePhysical();
      else rejectPhysical(new Error("late physical failure"));
      await result.settlement;
      expect(settled).toHaveBeenCalledOnce();
      expect(mocks.sdkCall.mock.calls).toEqual([["deletePath", ["/a"]]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
