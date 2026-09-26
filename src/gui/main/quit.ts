/**
 * The quit sequence after the user has decided to quit: stop the running job,
 * persist the queue, then terminate Electron.
 *
 * Each wait is bounded by `QUIT_WAIT_MS`. Stopping a job waits for its writer's
 * own cleanup (closing and removing its temp file) and the flush writes to the
 * storage root; either can stall on a stuck volume, and an unbounded wait would
 * leave quit silently doing nothing. When a bound elapses the sequence reports
 * it and moves on, so quitting always ends in `exit`.
 *
 * `app.quit()` is not a reliable continuation after macOS has already closed
 * the last window. `app.exit()` is safe here because the quit work has settled
 * or been abandoned first, and it deliberately avoids re-entering `before-quit`.
 */

/** How long quit waits for each step before moving on without it. */
export const QUIT_WAIT_MS = 10_000;

export interface QuitSteps {
  /** Cancel the running job and resolve once it has stopped. */
  stopJob(): Promise<void>;
  /** Persist the queue. */
  flush(): Promise<void>;
  /** The job did not stop within the bound; quit continues without it. */
  onJobStopTimeout(): void;
  onFlushed(): void;
  /** The flush failed or did not finish within the bound. */
  onFlushError(error: unknown): void;
  exit(code: number): void;
}

/** Resolves `true` when `work` settles within `ms`, `false` when the bound
 *  elapses first; a rejection of `work` within the bound propagates. */
async function settlesWithin(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true as const), elapsed]);
  } finally {
    clearTimeout(timer);
  }
}

export async function stopFlushAndExit(steps: QuitSteps, waitMs = QUIT_WAIT_MS): Promise<void> {
  try {
    if (!(await settlesWithin(steps.stopJob(), waitMs))) steps.onJobStopTimeout();
    try {
      if (await settlesWithin(steps.flush(), waitMs)) steps.onFlushed();
      else steps.onFlushError(new Error(`the queue flush did not finish within ${waitMs} ms`));
    } catch (error) {
      steps.onFlushError(error);
    }
  } finally {
    steps.exit(0);
  }
}
