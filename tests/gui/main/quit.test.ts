import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuitHandler, QUIT_WAIT_MS, stopFlushAndExit, type QuitSteps } from "../../../src/gui/main/quit.js";

function steps(overrides: Partial<QuitSteps> = {}): QuitSteps {
  return {
    stopJob: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    onJobStopTimeout: vi.fn(),
    onFlushed: vi.fn(),
    onFlushError: vi.fn(),
    closeBackups: vi.fn(async () => {}),
    closeLog: vi.fn(async () => {}),
    exit: vi.fn(),
    ...overrides,
  };
}

describe("stopFlushAndExit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the job, then flushes, then exits", async () => {
    const order: string[] = [];
    let finishJob!: () => void;
    const s = steps({
      stopJob: () => new Promise<void>((resolve) => { finishJob = () => { order.push("job"); resolve(); }; }),
      flush: async () => { order.push("flush"); },
      closeBackups: async () => { order.push("backups"); },
      closeLog: async () => { order.push("log"); },
      exit: (code) => { order.push(`exit ${code}`); },
    });

    const quitting = stopFlushAndExit(s);
    await Promise.resolve();
    expect(order).toEqual([]);

    finishJob();
    await quitting;
    expect(order).toEqual(["job", "flush", "backups", "log", "exit 0"]);
    expect(s.onFlushed).toHaveBeenCalledOnce();
    expect(s.onJobStopTimeout).not.toHaveBeenCalled();
  });

  it("reports a failed flush and still exits", async () => {
    const error = new Error("flush failed");
    const s = steps({ flush: async () => { throw error; } });

    await stopFlushAndExit(s);

    expect(s.onFlushError).toHaveBeenCalledWith(error);
    expect(s.exit).toHaveBeenCalledWith(0);
  });

  it("exits even when the cancelled job never finishes its cleanup", async () => {
    vi.useFakeTimers();
    const s = steps({ stopJob: () => new Promise<void>(() => {}) });

    const quitting = stopFlushAndExit(s);
    await vi.advanceTimersByTimeAsync(QUIT_WAIT_MS);
    await quitting;

    expect(s.onJobStopTimeout).toHaveBeenCalledOnce();
    expect(s.flush).toHaveBeenCalledOnce();
    expect(s.exit).toHaveBeenCalledWith(0);
  });

  it("exits even when the queue flush never finishes", async () => {
    vi.useFakeTimers();
    const s = steps({ flush: () => new Promise<void>(() => {}) });

    const quitting = stopFlushAndExit(s);
    await vi.advanceTimersByTimeAsync(QUIT_WAIT_MS);
    await quitting;

    expect(s.onFlushed).not.toHaveBeenCalled();
    expect(s.onFlushError).toHaveBeenCalledOnce();
    expect(s.exit).toHaveBeenCalledWith(0);
  });

  it("closes the log and exits even when the backup history never finishes closing", async () => {
    vi.useFakeTimers();
    const s = steps({ closeBackups: () => new Promise<void>(() => {}) });

    const quitting = stopFlushAndExit(s);
    await vi.advanceTimersByTimeAsync(QUIT_WAIT_MS);
    await quitting;

    expect(s.closeLog).toHaveBeenCalledOnce();
    expect(s.exit).toHaveBeenCalledWith(0);
  });

  it("exits even when the log never finishes closing", async () => {
    vi.useFakeTimers();
    const s = steps({ closeLog: () => new Promise<void>(() => {}) });

    const quitting = stopFlushAndExit(s);
    await vi.advanceTimersByTimeAsync(QUIT_WAIT_MS);
    await quitting;

    expect(s.onFlushed).toHaveBeenCalledOnce();
    expect(s.exit).toHaveBeenCalledWith(0);
  });
});

describe("createQuitHandler", () => {
  const quitEvent = () => ({ preventDefault: vi.fn() });

  it("holds a second quit during a pending shutdown, which alone ends the process", async () => {
    let finish!: () => void;
    const exit = vi.fn();
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            exit(0);
            resolve();
          };
        }),
    );
    const handle = createQuitHandler({ hasRunningJob: () => false, confirmQuit: vi.fn(), shutdown });

    const first = quitEvent();
    handle(first);
    await Promise.resolve();
    const second = quitEvent();
    handle(second);

    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
  });

  it("asks before cancelling a running job, and stays running when declined", async () => {
    const shutdown = vi.fn(async () => {});
    let answer = false;
    const confirmQuit = vi.fn(async () => answer);
    const handle = createQuitHandler({ hasRunningJob: () => true, confirmQuit, shutdown });

    handle(quitEvent());
    await vi.waitFor(() => expect(confirmQuit).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();

    answer = true;
    const again = quitEvent();
    handle(again);
    expect(again.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
  });
});
