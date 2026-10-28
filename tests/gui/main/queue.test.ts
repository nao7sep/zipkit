import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveQueue: vi.fn(),
  saveQueueWithin: vi.fn(),
  snapshot: vi.fn((): unknown[] => []),
  toResumable: vi.fn((jobs: unknown) => jobs),
  restore: vi.fn(),
  sdk: { pathState: vi.fn(), removeOriginals: vi.fn(), plan: vi.fn(), write: vi.fn(), verify: vi.fn(), pathKinds: vi.fn() },
  // The Trash the app hands its SDK.
  hostTrash: undefined as undefined | ((target: string) => Promise<void>),
  deps: undefined as
    | undefined
    | {
        emit(jobs: unknown[]): void;
        trash(
          paths: string[],
          signal: AbortSignal,
        ): Promise<{ moved: string[]; failed: Array<{ path: string; message: string }>; gone?: string[] }>;
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
  sendQueueSaved: vi.fn(),
}));
vi.mock("../../../src/gui/main/sdk.js", () => ({
  appZipKit: (trash: (target: string) => Promise<void>) => { mocks.hostTrash = trash; return {}; },
  createSdk: () => mocks.sdk,
}));
vi.mock("../../../src/gui/main/queue-engine.js", () => ({
  createQueueEngine: (deps: {
    emit(jobs: unknown[]): void;
    trash(
      paths: string[],
      signal: AbortSignal,
    ): Promise<{ moved: string[]; failed: Array<{ path: string; message: string }>; gone?: string[] }>;
  }) => {
    mocks.deps = deps;
    return { restore: mocks.restore, snapshot: mocks.snapshot };
  },
}));

import { shell } from "electron";
import { flushQueue, restoreQueue, saveQueueBeforeSessionEnd } from "../../../src/gui/main/queue.js";
import type { SavedJob } from "../../../src/gui/shared/queue.js";
import { SAVE } from "../../helpers/intents.js";
import { eventually } from "../../helpers/eventually.js";

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

  it("saves each emitted job list, and a flush waits for the save", async () => {
    const jobs = [{ id: "fresh" }];
    mocks.deps!.emit(jobs);
    await flushQueue();
    expect(mocks.toResumable).toHaveBeenCalledWith(jobs);
    expect(mocks.saveQueue).toHaveBeenCalledWith(jobs);
  });

  it("writes only the newest job list once the save in flight ends, and a flush joins it", async () => {
    let releaseFirst!: () => void;
    mocks.saveQueue.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    mocks.deps!.emit([{ id: "first" }]);
    await eventually(() => expect(mocks.saveQueue).toHaveBeenCalledTimes(1));
    mocks.deps!.emit([{ id: "second" }]);
    mocks.deps!.emit([{ id: "newest" }]);
    const flushed = flushQueue();
    releaseFirst();
    await flushed;
    expect(mocks.saveQueue.mock.calls.map(([jobs]) => jobs)).toEqual([[{ id: "first" }], [{ id: "newest" }]]);
  });
});

describe("saveQueueBeforeSessionEnd", () => {
  it("saves the jobs as they stand within the bound", () => {
    const jobs = [{ id: "running" }, { id: "queued" }];
    mocks.snapshot.mockReturnValueOnce(jobs);

    saveQueueBeforeSessionEnd(2_000);

    expect(mocks.saveQueueWithin).toHaveBeenCalledWith(jobs, 2_000);
  });
});


describe("the trash dependency", () => {
  beforeEach(() => {
    trashItem.mockReset();
  });

  it("stops before a path once the signal is already aborted, never calling shell.trashItem for it", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await mocks.deps!.trash(["/a", "/b"], controller.signal);

    expect(trashItem).not.toHaveBeenCalled();
    expect({ moved: result.moved, failed: result.failed }).toEqual({
      moved: [],
      failed: [
        { path: "/a", message: "cancelled before Trash" },
        { path: "/b", message: "cancelled before Trash" },
      ],
    });
  });

  it("lets a running Trash call end when the signal aborts, and starts no other", async () => {
    let finish!: () => void;
    trashItem.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const controller = new AbortController();

    const pending = mocks.deps!.trash(["/a", "/b"], controller.signal);
    controller.abort();
    finish();
    const result = await pending;

    expect(trashItem).toHaveBeenCalledTimes(1);
    expect({ moved: result.moved, failed: result.failed }).toEqual({
      moved: ["/a"],
      failed: [{ path: "/b", message: "cancelled before Trash" }],
    });
  });

  it("reports a path the OS refuses to move as kept", async () => {
    trashItem.mockRejectedValue(new Error("permission denied"));
    mocks.sdk.pathState.mockResolvedValueOnce({ kind: "present", fingerprint: "1:1:1:1" });

    const result = await mocks.deps!.trash(["/a"], new AbortController().signal);

    expect({ moved: result.moved, failed: result.failed }).toEqual({ moved: [], failed: [{ path: "/a", message: "permission denied" }] });
  });

  it("reports a path something else moved or deleted first as gone, not kept", async () => {
    trashItem.mockRejectedValue(new Error("no such file"));
    mocks.sdk.pathState.mockResolvedValueOnce({ kind: "missing" });

    const result = await mocks.deps!.trash(["/a"], new AbortController().signal);

    expect(mocks.sdk.pathState).toHaveBeenCalledWith("/a");
    expect({ moved: result.moved, failed: result.failed, gone: result.gone }).toEqual({ moved: [], failed: [], gone: ["/a"] });
  });

  it("moves every path in turn", async () => {
    trashItem.mockResolvedValue(undefined);

    const result = await mocks.deps!.trash(["/a", "/b"], new AbortController().signal);

    expect(trashItem).toHaveBeenCalledTimes(2);
    expect({ moved: result.moved, failed: result.failed }).toEqual({ moved: ["/a", "/b"], failed: [] });
  });
});

describe("the SDK wiring", () => {
  type Wired = {
    plan(inputs: string[], options: unknown, signal: AbortSignal, onEvent: () => void): Promise<object>;
    write(plan: object, signal: AbortSignal, onEvent: () => void): Promise<number | null>;
    verify(output: string, signal: AbortSignal, onEvent: () => void, manifestName: string | null): Promise<boolean>;
    pathKinds(paths: string[]): Promise<unknown>;
    removeOriginals(output: string, inputs: string[], removed: string[], options: unknown, method: string, signal: AbortSignal, onEvent: () => void): Promise<unknown>;
  };
  const wired = () => mocks.deps as unknown as Wired;

  it("passes the plan to the engine and back to be written", async () => {
    const plan = { mode: "plan", output: "/out.zip", writable: true, instructions: { entries: [{ archivePath: "a" }] } };
    mocks.sdk.plan.mockResolvedValueOnce(plan);
    mocks.sdk.write.mockResolvedValueOnce(42);
    const signal = new AbortController().signal;
    const onEvent = vi.fn();
    const planned = await wired().plan(["/in"], { level: 6 }, signal, onEvent);
    expect(mocks.sdk.plan).toHaveBeenLastCalledWith(["/in"], { level: 6 }, { signal, onEvent });
    expect(planned).toBe(plan);
    await expect(wired().write(planned, signal, onEvent)).resolves.toBe(42);
    expect(mocks.sdk.write).toHaveBeenLastCalledWith(plan, { signal, onEvent, onProgress: undefined });
  });

  it("asks the SDK to verify and to classify paths", async () => {
    mocks.sdk.verify.mockResolvedValueOnce(true);
    mocks.sdk.pathKinds.mockResolvedValueOnce([{ path: "/in", kind: "directory" }]);
    const signal = new AbortController().signal;
    await expect(wired().verify("/out.zip", signal, vi.fn(), "zipkit.json")).resolves.toBe(true);
    await expect(wired().pathKinds(["/in"])).resolves.toEqual([{ path: "/in", kind: "directory" }]);
  });

  it("asks the SDK to remove the originals, which it moves to the OS Trash through Electron", async () => {
    const removal = { refusal: null, verified: null, outcome: { moved: ["/in"], failed: [] } };
    mocks.sdk.removeOriginals.mockResolvedValueOnce(removal);
    const signal = new AbortController().signal;
    const onEvent = vi.fn();
    await expect(wired().removeOriginals("/out.zip", ["/in"], [], { level: 6 }, "trash", signal, onEvent)).resolves.toBe(removal);
    expect(mocks.sdk.removeOriginals).toHaveBeenLastCalledWith("/out.zip", ["/in"], [], { level: 6 }, "trash", { signal, onEvent, onProgress: undefined });
    trashItem.mockResolvedValueOnce(undefined);
    await mocks.hostTrash!("/in");
    expect(trashItem).toHaveBeenLastCalledWith("/in");
  });
});
