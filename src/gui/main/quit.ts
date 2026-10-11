/**
 * Quitting, per the unsaved-edits-conventions (Quitting). Every quit reaches
 * the same sequence: stop the running job, finish submitted Settings, save the queue, let the last pane
 * layout write land, let the backup history and the log write what they hold,
 * then terminate Electron.
 *
 * The queue and submitted Settings are the user's work. When either cannot be saved on a quit the user
 * started, the quit stops and asks: Retry, Quit Anyway, or Cancel, which keeps
 * the app open. Everything else is logged and the quit goes on. When the OS is
 * ending the session nothing asks: a question already open is answered for it,
 * and a failed save is logged.
 *
 * Every step is bounded, and the bounds together stay under the five seconds an
 * OS gives an app when the session ends. A step past its bound is logged and
 * left behind, so quitting always ends in an exit; its outcome is unknown. Work
 * left behind may be stuck in a native call (a hung volume, a worker inside
 * SQLite), and Electron's ordinary exit waits for such work, so a quit that left
 * a step behind ends through `forceExit` instead.
 *
 * `app.quit()` is not a reliable continuation after macOS has already closed
 * the last window. `app.exit()` is safe here because the quit work has settled
 * or been abandoned first, and it deliberately avoids re-entering `before-quit`.
 */

import { StepTimeout } from "./step-timeout.js";

/** How long quit waits for each step before moving on without it. */
export const QUIT_BOUNDS_MS = {
  stopJob: 1_500,
  settings: 500,
  flush: 1_000,
  layout: 500,
  backups: 500,
  log: 500,
} as const;

/** Total time the end of a Windows session waits for required saves. */
export const SESSION_END_SAVE_MS = 2_000;

/** How long powerMonitor's `shutdown` marks the session as ending when no quit
 *  follows it. Electron reports no cancelled logout (another app can veto it), so
 *  after this window a quit is the user's again and asks its questions. Too short
 *  a window could put a question in front of a real logout and block it; too long
 *  only skips the questions for a quit soon after a cancelled logout. Shared with
 *  BigMouth and TapeBox. */
export const SESSION_END_MARK_MS = 60_000;

/** The steps whose failure quit logs and goes on from. */
export type QuitStep = "job" | "settings" | "queue" | "layout" | "backups" | "question";

/** What the user chose about a queue that could not be saved. */
export type QueueNotSavedChoice = "retry" | "quit" | "cancel";

/** The state of the session a quit runs in. */
export interface QuitSession {
  /** Whether the OS is ending the session, so nothing may ask. */
  readonly ending: boolean;
  /** Aborted when the session starts ending, which answers a question already open. */
  readonly signal: AbortSignal;
}

export interface QuitSteps {
  /** Cancel the running job and resolve once it has stopped. */
  stopJob(): Promise<void>;
  settleSettings(): Promise<void>;
  askSettingsNotSaved(signal: AbortSignal): Promise<QueueNotSavedChoice>;
  /** Persist the queue. */
  flush(): Promise<void>;
  onFlushed(): void;
  /** Ask what to do about a queue that could not be saved. */
  askQueueNotSaved(signal: AbortSignal): Promise<QueueNotSavedChoice>;
  /** The user chose to keep the app open. */
  onCancelled(): void;
  /** Settle the pane layout writes in flight. */
  settleLayout(): Promise<void>;
  /** Write the backup history's records still in flight. */
  closeBackups(): Promise<void>;
  /** Write the log's records still in flight. */
  closeLog(): Promise<void>;
  /** A step failed or passed its bound; quit goes on without it. */
  onStepFailed(step: QuitStep, error: unknown): void;
  exit(code: number): void;
  /** End the process without the runtime's own cleanup, which can wait forever
   *  on work stuck in a native call. */
  forceExit(): void;
}

export { StepTimeout };

/** Resolves `undefined` when `work` succeeds within `ms`, its error when it
 *  fails, and a timeout error when the bound elapses first. Never rejects. */
async function failureWithin(work: () => Promise<void>, ms: number, what: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<Error>((resolve) => {
    timer = setTimeout(() => resolve(new StepTimeout(`${what} did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([
      (async () => {
        await work();
        return undefined;
      })().catch((error: unknown) => error ?? new Error(`${what} failed`)),
      elapsed,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The quit sequence. It ends the process, unless the user chose to keep the
 *  app open after the queue could not be saved. */
export async function stopFlushAndExit(steps: QuitSteps, session: QuitSession): Promise<void> {
  let cancelled = false;
  let leftBehind = false;
  const bounded = async (work: () => Promise<void>, ms: number, what: string): Promise<unknown> => {
    const error = await failureWithin(work, ms, what);
    if (error instanceof StepTimeout) leftBehind = true;
    return error;
  };
  try {
    const jobError = await bounded(steps.stopJob, QUIT_BOUNDS_MS.stopJob, "the cancelled job");
    if (jobError !== undefined) steps.onStepFailed("job", jobError);
    for (const save of [
      { work: steps.settleSettings, bound: QUIT_BOUNDS_MS.settings, step: "settings" as const,
        ask: steps.askSettingsNotSaved, done: () => {} },
      { work: steps.flush, bound: QUIT_BOUNDS_MS.flush, step: "queue" as const,
        ask: steps.askQueueNotSaved, done: steps.onFlushed },
    ]) {
      for (;;) {
        const flushError = await bounded(save.work, save.bound, `the ${save.step} save`);
        if (flushError === undefined) {
          save.done();
          break;
        }
        steps.onStepFailed(save.step, flushError);
        if (session.ending) break;
        let choice: QueueNotSavedChoice;
        try {
          choice = await save.ask(session.signal);
        } catch (error) {
          steps.onStepFailed("question", error);
          if (session.ending) break;
          cancelled = true;
          steps.onCancelled();
          return;
        }
        if (session.ending || choice === "quit") break;
        if (choice === "cancel") {
          cancelled = true;
          steps.onCancelled();
          return;
        }
      }
    }
  } finally {
    if (!cancelled) {
      const layoutError = await bounded(steps.settleLayout, QUIT_BOUNDS_MS.layout, "the pane layout write");
      if (layoutError !== undefined) steps.onStepFailed("layout", layoutError);
      // The backup history may log a failure, so the log closes last. At the end of an OS session
      // its pending writes are skipped (data-backup conventions); SQLite's journal keeps the store
      // whole when the process ends with the thread still open.
      if (!session.ending) {
        const backupsError = await bounded(steps.closeBackups, QUIT_BOUNDS_MS.backups, "the backup history");
        if (backupsError !== undefined) steps.onStepFailed("backups", backupsError);
      }
      // A log that cannot close has nowhere to report it.
      await bounded(steps.closeLog, QUIT_BOUNDS_MS.log, "the log");
      if (leftBehind) steps.forceExit();
      else steps.exit(0);
    }
  }
}

/** Startup presentation failure still reaches a bounded cleanup and exit tail. */
export async function finishStartupHalt(steps: {
  present(): Promise<void>;
  closeBackups(): Promise<void>;
  closeLog(): Promise<void>;
  onFailed(error: unknown): void;
  exit(code: number): void;
  forceExit(): void;
}): Promise<void> {
  try {
    await steps.present();
  } catch (error) {
    steps.onFailed(error);
  } finally {
    const backups = await failureWithin(steps.closeBackups, QUIT_BOUNDS_MS.backups, "startup backup cleanup");
    if (backups !== undefined) steps.onFailed(backups);
    const log = await failureWithin(steps.closeLog, QUIT_BOUNDS_MS.log, "startup log cleanup");
    if (backups instanceof StepTimeout || log instanceof StepTimeout) steps.forceExit();
    else steps.exit(1);
  }
}

export interface SessionEndSteps {
  saveSettingsNow(boundMs: number): void;
  /** Save the queue before returning, within the bound; throws when it could not, a
   *  {@link StepTimeout} when its thread did not answer in time. */
  saveQueueNow(boundMs: number): void;
  onSaved(): void;
  onStepFailed(step: QuitStep, error: unknown): void;
  exit(code: number): void;
  forceExit(): void;
}

/**
 * The end of a Windows session (logoff, restart, shutdown). Electron emits no
 * `before-quit` then, and the OS ends the process as soon as the main window's
 * `session-end` handler returns, so this saves submitted Settings and the queue within
 * its bound, logs a failure, and exits before returning. It never asks. The save
 * writes the engine's current jobs, never older than a debounced save already
 * under way; that save can finish only the one call it has started while this
 * thread waits, so an older rename landing last is not a path worth more
 * machinery.
 */
export function endSessionNow(steps: SessionEndSteps): void {
  let leftBehind = false;
  const deadline = Date.now() + SESSION_END_SAVE_MS;
  try {
    for (const [step, save] of [
      ["settings", steps.saveSettingsNow], ["queue", steps.saveQueueNow],
    ] as const) {
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new StepTimeout("session save deadline elapsed");
        save(remaining);
        if (step === "queue") steps.onSaved();
      } catch (error) {
        leftBehind ||= error instanceof StepTimeout;
        steps.onStepFailed(step, error);
      }
    }
  } finally {
    if (leftBehind) steps.forceExit();
    else steps.exit(0);
  }
}

export interface QuitRequestSteps {
  /** Whether a job is still writing, verifying, or moving originals to Trash. */
  hasRunningJob(): boolean;
  /** Ask whether to cancel that job and quit; resolves `true` to quit. */
  confirmQuit(signal: AbortSignal): Promise<boolean>;
  /** The quit sequence; it ends the process unless the user keeps the app open. */
  shutdown(session: QuitSession): Promise<void>;
  /** A failed confirmation or shutdown leaves the user-started quit retryable. */
  onFailed(error: unknown): void;
}

export interface QuitControl {
  /** The `before-quit` handler. */
  beforeQuit(event: { preventDefault(): void }): void;
  /** The OS is ending the session (macOS and Linux announce it before their
   *  quit): a question already open is answered for it, and nothing asks again. */
  sessionEnding(): void;
}

/**
 * Every quit is held, the repeat ones included: only the shutdown's own
 * `app.exit()` ends the process, so a second Cmd+Q, or `window-all-closed`
 * quitting while shutdown runs, waits for it instead of letting Electron end
 * the process before the queue and the log are written. One decision runs at a
 * time; declining a question leaves the app running and the next quit asks
 * again. A session end marks the session as ending for {@link SESSION_END_MARK_MS}:
 * a quit inside that window belongs to it and asks nothing, and once a quit has
 * started the mark no longer expires. No event says the user cancelled a logout,
 * so without a quit the mark lapses and the next quit asks again.
 */
export function createQuitControl(steps: QuitRequestSteps): QuitControl {
  let pending = false;
  let ending = false;
  let questions = new AbortController();
  let markTimer: ReturnType<typeof setTimeout> | undefined;
  const session: QuitSession = {
    get ending() {
      return ending;
    },
    get signal() {
      return questions.signal;
    },
  };
  return {
    beforeQuit(event) {
      event.preventDefault();
      if (pending) return;
      pending = true;
      // The session end this quit belongs to no longer expires.
      clearTimeout(markTimer);
      markTimer = undefined;
      void (async () => {
        try {
          // A job still running has no bounded way to finish on its own schedule,
          // so quitting must choose: cancel it (its writer removes its own temp
          // file, within quit's bound) or let the user keep working. An ending
          // session cancels it without asking.
          if (!ending && steps.hasRunningJob()) {
            let confirmed: boolean;
            try {
              confirmed = await steps.confirmQuit(questions.signal);
            } catch (error) {
              steps.onFailed(error);
              if (!ending) return;
              confirmed = false;
            }
            if (!confirmed && !ending) return;
          }
          await steps.shutdown(session);
        } catch (error) {
          steps.onFailed(error);
        } finally {
          pending = false;
        }
      })();
    },
    sessionEnding() {
      ending = true;
      questions.abort();
      if (pending) return;
      clearTimeout(markTimer);
      markTimer = setTimeout(() => {
        markTimer = undefined;
        if (pending) return;
        ending = false;
        questions = new AbortController();
      }, SESSION_END_MARK_MS);
    },
  };
}
