/**
 * Whole-second UTC time helpers for the backup index. Sub-second precision is deliberately dropped: the
 * modification time is compared with a two-second tolerance (see the data-backup conventions), so it
 * carries no fractional component and stays portable across filesystems (FAT/exFAT are 2-second).
 */

/** A whole-second UTC ISO-8601 stamp (`yyyy-MM-ddTHH:mm:ssZ`) from an epoch-milliseconds value. */
export function toIsoSeconds(msSinceEpoch: number): string {
  return new Date(msSinceEpoch).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Truncate an epoch-milliseconds value to the whole second. */
export function truncateToSecondMs(msSinceEpoch: number): number {
  return Math.floor(msSinceEpoch / 1000) * 1000;
}

/** `yyyymmdd-hhmmss-utc` — the second-precision UTC run stamp used for the archive name and the index
 *  entries' `archivedAt` (timestamp conventions). Matches the GUI session log's stamp so the two views
 *  of a launch line up; a same-second double-launch collision is accepted, not engineered around. */
export function formatArchivedAt(now: Date): string {
  const s = now.toISOString().slice(0, 19).replace(/[-:]/g, "");
  return `${s.replace("T", "-")}-utc`;
}
