/**
 * The ZIP DOS date/time field: the one owner of how an instant becomes that
 * field and of when it has to be clamped. The field stores *local* wall-clock
 * time with no zone and can represent only 1980-01-01 through 2107-12-31 in
 * that wall clock, so whether a time is out of range depends on the zone it is
 * rendered in. The plan's timestamp pass and the writer both call
 * {@link dosDateTime} with the same resolved zone, so the warning a plan raises
 * is exactly the clamping the writer applies.
 */

import { wallClockInZone } from "./timeZone.js";

/** Which DOS bound a time was clamped to, if any. */
export type DosClamp = "pre-1980" | "post-2107";

/** The packed DOS date and time words, and the bound applied to reach them. */
export interface DosDateTime {
  date: number;
  time: number;
  clamped: DosClamp | null;
}

// 1980-01-01 00:00:00, the DOS epoch; the floor.
const DOS_MIN = { date: (1 << 5) | 1, time: 0 };
// 2107-12-31 23:59:58, the latest time the field can represent; the ceiling.
const DOS_MAX = { date: ((2107 - 1980) << 9) | (12 << 5) | 31, time: (23 << 11) | (59 << 5) | 29 };

// The widest instant JS `Date` can represent (±100,000,000 days from the epoch).
// An instant beyond this cannot be rendered, so it is clamped by sign.
const DATE_MS_LIMIT = 8_640_000_000_000_000;

/**
 * The DOS date/time of `mtimeNs` rendered in `timeZone` (an IANA zone, already
 * resolved). The range is judged on the *local* components, not the UTC
 * instant: a zone offset can carry an instant inside the UTC window just past
 * the 1980/2107 edges, which would otherwise overflow the packed 16-bit fields.
 */
export function dosDateTime(mtimeNs: bigint, timeZone: string): DosDateTime {
  const ms = Number(mtimeNs / 1_000_000n);
  if (!Number.isFinite(ms) || ms < -DATE_MS_LIMIT) return { ...DOS_MIN, clamped: "pre-1980" };
  if (ms > DATE_MS_LIMIT) return { ...DOS_MAX, clamped: "post-2107" };
  const w = wallClockInZone(ms, timeZone);
  if (w.year < 1980) return { ...DOS_MIN, clamped: "pre-1980" };
  if (w.year > 2107) return { ...DOS_MAX, clamped: "post-2107" };
  return {
    date: ((w.year - 1980) << 9) | (w.month << 5) | w.day,
    time: (w.hour << 11) | (w.minute << 5) | (w.second >> 1),
    clamped: null,
  };
}
