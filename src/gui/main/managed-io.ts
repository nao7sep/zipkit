/** Bounded callers share each managed path's actual I/O order, including late cleanup. */
const tails = new Map<string, Promise<unknown>>();
/** The bound on a startup read: a launch that cannot read its stores halts with a dialog and
 *  writes nothing. In-session saves pass no bound and wait for the actual outcome, because a
 *  caller timeout does not prove that a write failed (PLAYBOOK, Respect data and lifetime). */
export const MANAGED_IO_WAIT_MS = 5_000;

export function managedIO<T>(file: string, start: (signal: AbortSignal) => Promise<T>, waitMs?: number): Promise<T> {
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
  if (waitMs === undefined) return work;
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
