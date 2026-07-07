/**
 * Choosing which stored time to restore to an extracted file. The archive may
 * carry up to three representations of the modification time; this picks the
 * most faithful one available, in order:
 *
 *   1. NTFS extra (0x000a) — absolute UTC, 100-ns, and carries access time too.
 *   2. Info-ZIP extended timestamp (0x5455) — absolute UTC seconds. In the
 *      central record only the modification time is present, so access falls
 *      back to it.
 *   3. DOS field — local wall-clock with no zone, interpreted in the configured
 *      zone. The lossy last resort, for archives carrying no UTC extra.
 *
 * Creation/birth time is deliberately not restored: no portable cross-platform
 * API sets it, so claiming to would be dishonest. Pure — no filesystem access.
 */

import { instantFromWallClockInZone } from "../internal/timeZone.js";
import { findExtra, type ReadEntry } from "./zipReader.js";

// 100-ns ticks between the FILETIME epoch (1601) and the Unix epoch (1970).
const NTFS_EPOCH_OFFSET = 116_444_736_000_000_000n;

export interface RestoreTimes {
  /** Modification time, epoch milliseconds. */
  mtimeMs: number;
  /** Access time, epoch milliseconds. */
  atimeMs: number;
}

function filetimeToMs(ticks: bigint): number {
  return Number((ticks - NTFS_EPOCH_OFFSET) / 10_000n);
}

export function restoreTimes(entry: ReadEntry, timeZone: string): RestoreTimes {
  const ntfs = findExtra(entry.extra, 0x000a);
  if (ntfs && ntfs.length >= 24) {
    // data: reserved(4) tag1(2) size1(2) mtime(8) atime(8) ctime(8)
    return { mtimeMs: filetimeToMs(ntfs.readBigUInt64LE(8)), atimeMs: filetimeToMs(ntfs.readBigUInt64LE(16)) };
  }

  const ut = findExtra(entry.extra, 0x5455);
  if (ut && ut.length >= 5 && (ut[0]! & 0x01) === 0x01) {
    const ms = ut.readInt32LE(1) * 1000;
    return { mtimeMs: ms, atimeMs: ms };
  }

  // DOS field: local wall-clock, no zone — interpret it in the configured zone.
  const ms = instantFromWallClockInZone(
    {
      year: ((entry.dosDate >> 9) & 0x7f) + 1980,
      month: (entry.dosDate >> 5) & 0x0f,
      day: entry.dosDate & 0x1f,
      hour: (entry.dosTime >> 11) & 0x1f,
      minute: (entry.dosTime >> 5) & 0x3f,
      second: (entry.dosTime & 0x1f) * 2,
    },
    timeZone,
  );
  return { mtimeMs: ms, atimeMs: ms };
}
