/**
 * Calling a caller's hook so it cannot break the verb: what it throws is
 * dropped, and so is a rejection of the promise an `async` hook returns,
 * which would otherwise be unhandled and, by Node's default, end the process.
 */
export function observe(call: () => unknown): void {
  try {
    const result = call();
    if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") {
      (result as PromiseLike<unknown>).then(undefined, () => {});
    }
  } catch {
    /* best-effort: the hook's failure is not the run's */
  }
}
