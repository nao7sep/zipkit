/**
 * Quitting, per the unsaved-edits-conventions (Quitting). Every quit reaches
 * the same sequence: stop the running job, save the queue, let the last pane
 * layout write land, let the backup history and the log write what they hold,
 * then terminate Electron.
 *
 * The queue is the user's own work. When it cannot be saved on a quit the user
 * started, the quit stops and asks: Retry, Quit Anyway, or Cancel, which keeps
 * the app open. Everything else is logged and the quit goes on. When the OS is
 * ending the session nothing asks: a question already open is answered for it,
 * and a failed save is logged.
 *
 * Every step is bounded, and the bounds together stay under the five seconds an
 * OS gives an app when the session ends. A step past its bound is logged and
 * left behind, so quitting always ends in `exit`; its outcome is unknown.
 *
 * `app.quit()` is not a reliable continuation after macOS has already closed
 * the last window. `app.exit()` is safe here because the quit work has settled
 * or been abandoned first, and it deliberately avoids re-entering `before-quit`.
 */

/** How long quit waits for each step before moving on without it. */
export const QUIT_BOUNDS_MS = {
  stopJob: 1_500,
  flush: 1_000,
  layout: 500,
  backups: 500,
  log: 500,
} as const;

/** The steps whose failure quit logs and goes on from. */
export type QuitStep = "job" | "queue" | "layout" | "backups";

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
}

/** Resolves `undefined` when `work` succeeds within `ms`, its error when it
 *  fails, and a timeout error when the bound elapses first. Never rejects. */
async function failureWithin(work: () => Promise<void>, ms: number, what: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<Error>((resolve) => {
    timer = setTimeout(() => resolve(new Error(`${what} did not finish within ${ms} ms`)), ms);
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
  try {
    const jobError = await failureWithin(steps.stopJob, QUIT_BOUNDS_MS.stopJob, "the cancelled job");
    if (jobError !== undefined) steps.onStepFailed("job", jobError);
    for (;;) {
      const flushError = await failureWithin(steps.flush, QUIT_BOUNDS_MS.flush, "the queue save");
      if (flushError === undefined) {
        steps.onFlushed();
        break;
      }
      steps.onStepFailed("queue", flushError);
      if (session.ending) break;
      const choice = await steps.askQueueNotSaved(session.signal);
      if (session.ending || choice === "quit") break;
      if (choice === "cancel") {
        cancelled = true;
        steps.onCancelled();
        return;
      }
    }
  } finally {
    if (!cancelled) {
      const layoutError = await failureWithin(steps.settleLayout, QUIT_BOUNDS_MS.layout, "the pane layout write");
      if (layoutError !== undefined) steps.onStepFailed("layout", layoutError);
      // The backup history may log a failure, so the log closes last.
      const backupsError = await failureWithin(steps.closeBackups, QUIT_BOUNDS_MS.backups, "the backup history");
      if (backupsError !== undefined) steps.onStepFailed("backups", backupsError);
      // A log that cannot close has nowhere to report it.
      await failureWithin(steps.closeLog, QUIT_BOUNDS_MS.log, "the log");
      steps.exit(0);
    }
  }
}

export interface QuitRequestSteps {
  /** Whether a job is still writing, verifying, or moving originals to Trash. */
  hasRunningJob(): boolean;
  /** Ask whether to cancel that job and quit; resolves `true` to quit. */
  confirmQuit(signal: AbortSignal): Promise<boolean>;
  /** The quit sequence; it ends the process unless the user keeps the app open. */
  shutdown(session: QuitSession): Promise<void>;
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
 * again. A session that starts ending stays ending: no event says the user
 * cancelled the logout.
 */
export function createQuitControl(steps: QuitRequestSteps): QuitControl {
  let pending = false;
  let ending = false;
  const questions = new AbortController();
  const session: QuitSession = {
    get ending() {
      return ending;
    },
    signal: questions.signal,
  };
  return {
    beforeQuit(event) {
      event.preventDefault();
      if (pending) return;
      pending = true;
      void (async () => {
        try {
          // A job still running has no bounded way to finish on its own schedule,
          // so quitting must choose: cancel it (its writer removes its own temp
          // file, within quit's bound) or let the user keep working. An ending
          // session cancels it without asking.
          if (!ending && steps.hasRunningJob() && !(await steps.confirmQuit(questions.signal)) && !ending) return;
          await steps.shutdown(session);
        } finally {
          pending = false;
        }
      })();
    },
    sessionEnding() {
      ending = true;
      questions.abort();
    },
  };
}
