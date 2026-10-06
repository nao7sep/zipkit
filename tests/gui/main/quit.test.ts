import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createQuitControl,
  QUIT_BOUNDS_MS,
  stopFlushAndExit,
  type QuitSession,
  type QuitSteps,
} from "../../../src/gui/main/quit.js";

function steps(overrides: Partial<QuitSteps> = {}): QuitSteps {
  return {
    stopJob: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    onFlushed: vi.fn(),
    askQueueNotSaved: vi.fn(async () => "quit" as const),
    onCancelled: vi.fn(),
    settleLayout: vi.fn(async () => {}),
    closeBackups: vi.fn(async () => {}),
    closeLog: vi.fn(async () => {}),
    onStepFailed: vi.fn(),
    exit: vi.fn(),
    ...overrides,
  };
}

/** A quit the user started, which the OS can turn into an ending session. */
function userQuit(): QuitSession & { end(): void } {
  const questions = new AbortController();
  let ending = false;
  return {
    get ending() {
      return ending;
    },
    signal: questions.signal,
    end() {
      ending = true;
      questions.abort();
    },
  };
}

function endingSession(): QuitSession {
  const session = userQuit();
  session.end();
  return session;
}

const never = () => new Promise<void>(() => {});
const totalBound = Object.values(QUIT_BOUNDS_MS).reduce((sum, ms) => sum + ms, 0);

describe("stopFlushAndExit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the job, saves the queue, settles the layout, closes the backups and the log, then exits", async () => {
    const order: string[] = [];
    let finishJob!: () => void;
    const s = steps({
      stopJob: () => new Promise<void>((resolve) => { finishJob = () => { order.push("job"); resolve(); }; }),
      flush: async () => { order.push("flush"); },
      settleLayout: async () => { order.push("layout"); },
      closeBackups: async () => { order.push("backups"); },
      closeLog: async () => { order.push("log"); },
      exit: (code) => { order.push(`exit ${code}`); },
    });

    const quitting = stopFlushAndExit(s, userQuit());
    await Promise.resolve();
    expect(order).toEqual([]);

    finishJob();
    await quitting;
    expect(order).toEqual(["job", "flush", "layout", "backups", "log", "exit 0"]);
    expect(s.onFlushed).toHaveBeenCalledOnce();
    expect(s.onStepFailed).not.toHaveBeenCalled();
    expect(s.askQueueNotSaved).not.toHaveBeenCalled();
  });

  it("keeps the app open when the queue was not saved and the user cancels", async () => {
    const error = new Error("disk full");
    const s = steps({
      flush: async () => { throw error; },
      askQueueNotSaved: vi.fn(async () => "cancel" as const),
    });

    await stopFlushAndExit(s, userQuit());

    expect(s.onStepFailed).toHaveBeenCalledWith("queue", error);
    expect(s.askQueueNotSaved).toHaveBeenCalledOnce();
    expect(s.onCancelled).toHaveBeenCalledOnce();
    expect(s.settleLayout).not.toHaveBeenCalled();
    expect(s.closeBackups).not.toHaveBeenCalled();
    expect(s.closeLog).not.toHaveBeenCalled();
    expect(s.exit).not.toHaveBeenCalled();
  });

  it("saves again on Retry, and exits once the save succeeds", async () => {
    const flush = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const s = steps({ flush, askQueueNotSaved: vi.fn(async () => "retry" as const) });

    await stopFlushAndExit(s, userQuit());

    expect(flush).toHaveBeenCalledTimes(2);
    expect(s.askQueueNotSaved).toHaveBeenCalledOnce();
    expect(s.onFlushed).toHaveBeenCalledOnce();
    expect(s.exit).toHaveBeenCalledWith(0);
  });

  it("exits without the queue on Quit Anyway", async () => {
    const s = steps({ flush: async () => { throw new Error("disk full"); } });

    await stopFlushAndExit(s, userQuit());

    expect(s.askQueueNotSaved).toHaveBeenCalledOnce();
    expect(s.onFlushed).not.toHaveBeenCalled();
    expect(s.closeLog).toHaveBeenCalledOnce();
    expect(s.exit).toHaveBeenCalledWith(0);
  });

  it("asks when the queue save does not finish within its bound", async () => {
    const s = steps({ flush: never, askQueueNotSaved: vi.fn(async () => "cancel" as const) });

    const quitting = stopFlushAndExit(s, userQuit());
    await vi.advanceTimersByTimeAsync(QUIT_BOUNDS_MS.flush - 1);
    expect(s.askQueueNotSaved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await quitting;

    expect(s.onStepFailed).toHaveBeenCalledWith("queue", expect.any(Error));
    expect(s.askQueueNotSaved).toHaveBeenCalledOnce();
    expect(s.exit).not.toHaveBeenCalled();
  });

  it("never asks while the session ends: a failed save is logged and the app exits", async () => {
    const s = steps({ flush: async () => { throw new Error("disk full"); } });

    await stopFlushAndExit(s, endingSession());

    expect(s.onStepFailed).toHaveBeenCalledWith("queue", expect.any(Error));
    expect(s.askQueueNotSaved).not.toHaveBeenCalled();
    expect(s.exit).toHaveBeenCalledWith(0);
  });

  it("exits when the session starts ending while the question is open", async () => {
    const session = userQuit();
    const s = steps({
      flush: async () => { throw new Error("disk full"); },
      askQueueNotSaved: vi.fn(
        (signal: AbortSignal) =>
          new Promise<"cancel">((resolve) => signal.addEventListener("abort", () => resolve("cancel"))),
      ),
    });

    const quitting = stopFlushAndExit(s, session);
    await vi.waitFor(() => expect(s.askQueueNotSaved).toHaveBeenCalledOnce());
    session.end();
    await quitting;

    expect(s.onCancelled).not.toHaveBeenCalled();
    expect(s.exit).toHaveBeenCalledWith(0);
  });

  it("logs a failed layout write and still exits", async () => {
    const error = new Error("layout write failed");
    const s = steps({ settleLayout: async () => { throw error; } });

    await stopFlushAndExit(s, userQuit());

    expect(s.onStepFailed).toHaveBeenCalledWith("layout", error);
    expect(s.askQueueNotSaved).not.toHaveBeenCalled();
    expect(s.exit).toHaveBeenCalledWith(0);
  });

  it("bounds every step, and exits within the total when none of them finishes", async () => {
    const s = steps({
      stopJob: never,
      flush: never,
      settleLayout: never,
      closeBackups: never,
      closeLog: never,
    });

    const quitting = stopFlushAndExit(s, endingSession());
    await vi.advanceTimersByTimeAsync(totalBound - 1);
    expect(s.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await quitting;

    expect(vi.mocked(s.onStepFailed).mock.calls.map(([step]) => step)).toEqual(["job", "queue", "layout", "backups"]);
    expect(s.exit).toHaveBeenCalledWith(0);
  });

  it("keeps the whole quit under the five seconds an ending session allows", () => {
    expect(totalBound).toBeLessThan(5_000);
  });
});

describe("createQuitControl", () => {
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
    const quit = createQuitControl({ hasRunningJob: () => false, confirmQuit: vi.fn(), shutdown });

    const first = quitEvent();
    quit.beforeQuit(first);
    await Promise.resolve();
    const second = quitEvent();
    quit.beforeQuit(second);

    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
  });

  it("asks before cancelling a running job, and stays running when declined", async () => {
    const shutdown = vi.fn(async (_session: QuitSession) => {});
    let answer = false;
    const confirmQuit = vi.fn(async () => answer);
    const quit = createQuitControl({ hasRunningJob: () => true, confirmQuit, shutdown });

    quit.beforeQuit(quitEvent());
    await vi.waitFor(() => expect(confirmQuit).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();

    answer = true;
    const again = quitEvent();
    quit.beforeQuit(again);
    expect(again.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    expect(shutdown.mock.calls[0]?.[0]).toMatchObject({ ending: false });
  });

  it("asks nothing once the session is ending, and tells the shutdown so", async () => {
    const shutdown = vi.fn(async (_session: QuitSession) => {});
    const confirmQuit = vi.fn(async () => false);
    const quit = createQuitControl({ hasRunningJob: () => true, confirmQuit, shutdown });

    quit.sessionEnding();
    quit.beforeQuit(quitEvent());

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    expect(confirmQuit).not.toHaveBeenCalled();
    expect(shutdown.mock.calls[0]?.[0]).toMatchObject({ ending: true });
  });

  it("answers an open job question when the session starts ending, and quits", async () => {
    const shutdown = vi.fn(async () => {});
    const confirmQuit = vi.fn(
      (signal: AbortSignal) => new Promise<boolean>((resolve) => signal.addEventListener("abort", () => resolve(false))),
    );
    const quit = createQuitControl({ hasRunningJob: () => true, confirmQuit, shutdown });

    quit.beforeQuit(quitEvent());
    await vi.waitFor(() => expect(confirmQuit).toHaveBeenCalledOnce());
    quit.sessionEnding();

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
  });
});
