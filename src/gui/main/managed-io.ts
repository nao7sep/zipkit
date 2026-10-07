/** Bounded callers share each managed path's actual I/O order, including late cleanup. */
const tails = new Map<string, Promise<unknown>>();
export const MANAGED_IO_WAIT_MS = 5_000;

export function managedIO<T>(file: string, start: (signal: AbortSignal) => Promise<T>, waitMs = MANAGED_IO_WAIT_MS): Promise<T> {
  const controller = new AbortController();
  const previous = tails.get(file) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(() => {
    controller.signal.throwIfAborted();
    return start(controller.signal);
  });
  tails.set(file, work);
  void work.finally(() => {
    if (tails.get(file) === work) tails.delete(file);
  }).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`managed I/O for ${file} did not finish within ${waitMs} ms`);
      controller.abort(error);
      reject(error);
    }, waitMs);
  });
  // Abandon only the caller's wait. An already-started rename can still land;
  // the actual operation retains its place in the tail until it settles.
  return Promise.race([work, elapsed]).finally(() => clearTimeout(timer));
}
