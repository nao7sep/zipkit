/**
 * The counts behind `onProgress`: how many entries and bytes a write or a read
 * has done of its total, reported at the start, at most every interval while
 * it runs, and once at the end, so a progress bar moves without a call per
 * chunk. The observer cannot break the verb.
 */

import type { ProgressCounts } from "./types.js";

/** How often a running count is reported, at most. */
const INTERVAL_MS = 100;

export class Meter {
  readonly #counts: ProgressCounts;
  readonly #sink: ((counts: ProgressCounts) => void) | undefined;
  readonly #now: () => number;
  #last = -Infinity;

  constructor(
    stage: ProgressCounts["stage"],
    totals: { entries: number; bytes: number },
    sink: ((counts: ProgressCounts) => void) | undefined,
    now: () => number = () => performance.now(),
  ) {
    this.#counts = { stage, entriesDone: 0, entriesTotal: totals.entries, bytesDone: 0, bytesTotal: totals.bytes };
    this.#sink = sink;
    this.#now = now;
    this.#report();
  }

  /** Bytes of an entry's content streamed. */
  bytes(count: number): void {
    if (this.#sink === undefined) return;
    this.#counts.bytesDone += count;
    if (this.#now() - this.#last >= INTERVAL_MS) this.#report();
  }

  /** One entry done. */
  entry(): void {
    if (this.#sink === undefined) return;
    this.#counts.entriesDone++;
    if (this.#now() - this.#last >= INTERVAL_MS) this.#report();
  }

  /** The run finished: report where it ended. */
  finish(): void {
    this.#report();
  }

  #report(): void {
    if (this.#sink === undefined) return;
    this.#last = this.#now();
    try { this.#sink({ ...this.#counts }); }
    catch { /* Like an event sink, the observer cannot break the verb. */ }
  }
}
