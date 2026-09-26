import { afterEach, describe, expect, it, vi } from "vitest";
import { QUIT_WAIT_MS, stopFlushAndExit, type QuitSteps } from "../../../src/gui/main/quit.js";

function steps(overrides: Partial<QuitSteps> = {}): QuitSteps {
  return {
    stopJob: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    onJobStopTimeout: vi.fn(),
    onFlushed: vi.fn(),
    onFlushError: vi.fn(),
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
      exit: (code) => { order.push(`exit ${code}`); },
    });

    const quitting = stopFlushAndExit(s);
    await Promise.resolve();
    expect(order).toEqual([]);

    finishJob();
    await quitting;
    expect(order).toEqual(["job", "flush", "exit 0"]);
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
});
