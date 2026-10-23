/** Pull work through a fixed worker set; do not enqueue a promise per entry.
 * Issued work settles before returning, including on the first failure. */
export function workerCount(limit: ((...args: never[]) => unknown) & { concurrency?: number }): number {
  return Math.max(1, Math.floor(limit.concurrency ?? 1));
}
export async function boundedMap<T, R>(items: readonly T[], count: number, run: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(items.length, count) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = { status: "fulfilled", value: await run(items[index]!) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; failed = true; }
    }
  }));
  return results;
}
