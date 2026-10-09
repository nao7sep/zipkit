import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createQuitControl,
  endSessionNow,
  QUIT_BOUNDS_MS,
  SESSION_END_MARK_MS,
  StepTimeout,
  SESSION_END_SAVE_MS,
  stopFlushAndExit,
  type QuitSession,
  type QuitSteps,
  type SessionEndSteps,
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
    forceExit: vi.fn(),
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

  it("a failed queue-save question cancels the user quit without closing stores or exiting", async () => {
    const error = new Error("presenter failed");
    const s = steps({ flush: async () => { throw new Error("save failed"); }, askQueueNotSaved: async () => { throw error; } });
    await stopFlushAndExit(s, userQuit());
    expect(s.onStepFailed).toHaveBeenCalledWith("question", error);
    expect(s.onCancelled).toHaveBeenCalledOnce();
    expect(s.closeBackups).not.toHaveBeenCalled();
    expect(s.closeLog).not.toHaveBeenCalled();
    expect(s.exit).not.toHaveBeenCalled();
  });

  it("a question rejection caused by session end still finishes bounded shutdown", async () => {
    const session = userQuit();
    const s = steps({
      flush: async () => { throw new Error("save failed"); },
      askQueueNotSaved: async () => { session.end(); throw new Error("aborted presenter"); },
    });
    await stopFlushAndExit(s, session);
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
      closeBackups: vi.fn(never),
      closeLog: never,
    });

    // An ending session skips the backup history's pending writes, so its bound is not spent.
    const endingBound = totalBound - QUIT_BOUNDS_MS.backups;
    const quitting = stopFlushAndExit(s, endingSession());
    await vi.advanceTimersByTimeAsync(endingBound - 1);
    expect(s.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await quitting;

    expect(vi.mocked(s.onStepFailed).mock.calls.map(([step]) => step)).toEqual(["job", "queue", "layout"]);
    expect(s.closeBackups).not.toHaveBeenCalled();
    // Work left behind may be stuck in a native call, so the exit does not wait for it.
    expect(s.forceExit).toHaveBeenCalledOnce();
    expect(s.exit).not.toHaveBeenCalled();
  });

  it("closes the backup history within its bound on an ordinary quit", async () => {
    const s = steps({ closeBackups: vi.fn(never) });

    const quitting = stopFlushAndExit(s, userQuit());
    await vi.advanceTimersByTimeAsync(QUIT_BOUNDS_MS.backups);
    await quitting;

    expect(s.closeBackups).toHaveBeenCalledOnce();
    expect(vi.mocked(s.onStepFailed).mock.calls.map(([step]) => step)).toEqual(["backups"]);
    expect(s.forceExit).toHaveBeenCalledOnce();
  });

  it("exits normally when a step fails without being left behind", async () => {
    const s = steps({ settleLayout: async () => { throw new Error("layout write failed"); } });

    await stopFlushAndExit(s, userQuit());

    expect(vi.mocked(s.onStepFailed).mock.calls.map(([step]) => step)).toEqual(["layout"]);
    expect(s.exit).toHaveBeenCalledWith(0);
    expect(s.forceExit).not.toHaveBeenCalled();
  });

  it("keeps the whole quit under the five seconds an ending session allows", () => {
    expect(totalBound).toBeLessThan(5_000);
    expect(SESSION_END_SAVE_MS).toBeLessThan(5_000);
  });
});

describe("endSessionNow (the end of a Windows session)", () => {
  it("forces the exit when the save thread did not answer, and exits normally after a plain failure", () => {
    const timedOut = sessionEndSteps({ saveQueueNow: vi.fn(() => { throw new StepTimeout("no answer"); }) });
    endSessionNow(timedOut);
    expect(timedOut.forceExit).toHaveBeenCalledOnce();
    expect(timedOut.exit).not.toHaveBeenCalled();

    const failed = sessionEndSteps({ saveQueueNow: vi.fn(() => { throw new Error("disk full"); }) });
    endSessionNow(failed);
    expect(failed.exit).toHaveBeenCalledWith(0);
    expect(failed.forceExit).not.toHaveBeenCalled();
  });

  function sessionEndSteps(overrides: Partial<SessionEndSteps> = {}): SessionEndSteps {
    return {
      saveQueueNow: vi.fn(),
      onSaved: vi.fn(),
      onStepFailed: vi.fn(),
      exit: vi.fn(),
      forceExit: vi.fn(),
      ...overrides,
    };
  }

  it("saves the queue within its bound and exits before returning", () => {
    const order: string[] = [];
    const s = sessionEndSteps({
      saveQueueNow: vi.fn(() => { order.push("save"); }),
      exit: vi.fn(() => { order.push("exit"); }),
    });

    endSessionNow(s);

    expect(s.saveQueueNow).toHaveBeenCalledWith(SESSION_END_SAVE_MS);
    expect(s.onSaved).toHaveBeenCalledOnce();
    expect(order).toEqual(["save", "exit"]);
  });

  it("logs a failed save, asks nothing, and still exits before returning", () => {
    const error = new Error("disk full");
    const s = sessionEndSteps({ saveQueueNow: vi.fn(() => { throw error; }) });

    endSessionNow(s);

    expect(s.onStepFailed).toHaveBeenCalledWith("queue", error);
    expect(s.onSaved).not.toHaveBeenCalled();
    expect(s.exit).toHaveBeenCalledWith(0);
  });
});

describe("createQuitControl", () => {
  it("reports a failed running-job question and releases the claim for a later quit", async () => {
    const failure = new Error("presenter failed");
    const confirmQuit = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(true);
    const shutdown = vi.fn(async () => {});
    const onFailed = vi.fn();
    const control = createQuitControl({ hasRunningJob: () => true, confirmQuit, shutdown, onFailed });
    const event = { preventDefault: vi.fn() };
    control.beforeQuit(event);
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalledWith(failure));
    expect(shutdown).not.toHaveBeenCalled();
    control.beforeQuit(event);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
  });

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
    const quit = createQuitControl({ onFailed: vi.fn(), hasRunningJob: () => false, confirmQuit: vi.fn(), shutdown });

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
    const quit = createQuitControl({ onFailed: vi.fn(), hasRunningJob: () => true, confirmQuit, shutdown });

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
    const quit = createQuitControl({ onFailed: vi.fn(), hasRunningJob: () => true, confirmQuit, shutdown });

    quit.sessionEnding();
    quit.beforeQuit(quitEvent());

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    expect(confirmQuit).not.toHaveBeenCalled();
    expect(shutdown.mock.calls[0]?.[0]).toMatchObject({ ending: true });
  });

  it("asks again once a session end passes with no quit, as when another app cancels the logout", async () => {
    vi.useFakeTimers();
    try {
      const shutdown = vi.fn(async (_session: QuitSession) => {});
      const confirmQuit = vi.fn(async () => true);
      const quit = createQuitControl({ onFailed: vi.fn(), hasRunningJob: () => true, confirmQuit, shutdown });

      quit.sessionEnding();
      await vi.advanceTimersByTimeAsync(SESSION_END_MARK_MS);
      quit.beforeQuit(quitEvent());

      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
      expect(confirmQuit).toHaveBeenCalledOnce();
      const [signal] = confirmQuit.mock.calls[0] as unknown as [AbortSignal];
      expect(signal.aborted).toBe(false);
      expect(shutdown.mock.calls[0]?.[0]).toMatchObject({ ending: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a quit that started inside the session end's window ending", async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const shutdown = vi.fn((_session: QuitSession) => new Promise<void>((resolve) => { finish = resolve; }));
      const quit = createQuitControl({ onFailed: vi.fn(), hasRunningJob: () => false, confirmQuit: vi.fn(), shutdown });

      quit.sessionEnding();
      await vi.advanceTimersByTimeAsync(SESSION_END_MARK_MS - 1);
      quit.beforeQuit(quitEvent());
      await vi.advanceTimersByTimeAsync(SESSION_END_MARK_MS);

      expect(shutdown.mock.calls[0]?.[0].ending).toBe(true);
      finish();
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers an open job question when the session starts ending, and quits", async () => {
    const shutdown = vi.fn(async () => {});
    const confirmQuit = vi.fn(
      (signal: AbortSignal) => new Promise<boolean>((resolve) => signal.addEventListener("abort", () => resolve(false))),
    );
    const quit = createQuitControl({ onFailed: vi.fn(), hasRunningJob: () => true, confirmQuit, shutdown });

    quit.beforeQuit(quitEvent());
    await vi.waitFor(() => expect(confirmQuit).toHaveBeenCalledOnce());
    quit.sessionEnding();

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
  });
});
