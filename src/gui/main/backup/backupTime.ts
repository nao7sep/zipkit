/**
 * UTC time helpers for the backup index. The change-detection side (`toIsoSeconds`,
 * `truncateToSecondMs`) is whole-second on purpose — sub-second precision is dropped because the
 * modification time is compared with a two-second tolerance (see the data-backup conventions), so it
 * carries no fractional component and stays portable across filesystems (FAT/exFAT are 2-second). The
 * run-stamp side (`formatArchivedAt`) is millisecond precision instead, per the timestamp conventions'
 * machine-paced form; existing index entries recorded under the older second-precision stamp remain
 * valid as-is (never migrated).
 */

/** A whole-second UTC ISO-8601 stamp (`yyyy-MM-ddTHH:mm:ssZ`) from an epoch-milliseconds value. */
export function toIsoSeconds(msSinceEpoch: number): string {
  return new Date(msSinceEpoch).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Truncate an epoch-milliseconds value to the whole second. */
export function truncateToSecondMs(msSinceEpoch: number): number {
  return Math.floor(msSinceEpoch / 1000) * 1000;
}

/** `yyyymmdd-hhmmss-fff-utc` — the millisecond-precision UTC run stamp used for the archive name and the
 *  index entries' `archivedAt` (timestamp conventions' machine-paced form). Matches the GUI session log's
 *  stamp so the two views of a launch line up. A same-millisecond double-launch collision is not accepted:
 *  the backup engine's no-clobber create (see `writeArchive` in backupEngine.ts) advances the instant one
 *  millisecond at a time and re-formats through this function until the stamped name is free. */
export function formatArchivedAt(now: Date): string {
  const s = now.toISOString().slice(0, 23).replace(/[-:]/g, "").replace(".", "-");
  return `${s.replace("T", "-")}-utc`;
}
