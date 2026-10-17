import type { Writable } from "node:stream";

import { AbortError } from "../errors.js";

/**
 * Wait for a writable stream's backpressure to clear.
 *
 * A bare `once("drain")` is a hang waiting to happen: `drain` is only ever
 * emitted by a stream that is still healthy, so a sink that ERRORS instead —
 * ENOSPC part-way through, EIO when a removable or network destination goes
 * away, a permissions change — never emits it, and the await never settles.
 * The surrounding try/catch does not help, because nothing was thrown; the job
 * simply stops, and anything queued behind it stops with it.
 *
 * So all three outcomes are wired: drained, failed, or cancelled. The abort
 * listener is what makes Cancel work DURING a wait rather than only between
 * chunks — checking the signal at the top of a sink is no use while the sink is
 * parked here.
 */
export function awaitDrain(stream: Writable, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const settle = (finish: () => void): void => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      finish();
    };
    const onDrain = (): void => settle(resolve);
    const onError = (err: Error): void => settle(() => reject(err));
    const onAbort = (): void => settle(() => reject(new AbortError()));

    stream.once("drain", onDrain);
    stream.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    // An already-aborted signal never fires the event.
    if (signal?.aborted === true) onAbort();
  });
}
