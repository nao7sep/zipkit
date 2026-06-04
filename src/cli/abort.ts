/**
 * SIGINT handling for the CLI. Each run gets its own `AbortController`, so a
 * cancellation never leaks between successive `runCli` calls in one process.
 * The process-level SIGINT listener is registered exactly once and always
 * targets the current run: the first interrupt aborts it (a short grace timer
 * then forces exit), a second exits immediately.
 */

const GRACE_MS = 2_000;

let current: AbortController | null = null;
let listenerInstalled = false;
let interruptCount = 0;

export function installSigintHandler(): AbortSignal {
  current = new AbortController();
  interruptCount = 0;

  if (!listenerInstalled) {
    listenerInstalled = true;
    process.on("SIGINT", () => {
      interruptCount += 1;
      if (interruptCount === 1) {
        current?.abort(new Error("interrupted by SIGINT"));
        setTimeout(() => process.exit(130), GRACE_MS).unref();
        return;
      }
      process.exit(130);
    });
  }

  return current.signal;
}
