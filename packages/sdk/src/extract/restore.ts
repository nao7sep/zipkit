/**
 * Choosing which stored time to restore to an extracted file. The archive may
 * carry up to three representations of the modification time; this picks the
 * most faithful one available, in order:
 *
 *   1. NTFS extra (0x000a) — absolute UTC, 100-ns, and carries access time too.
 *      Used only when its time attribute is well formed and its modification
 *      time is set; a third-party writer's malformed or zero field falls through.
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

/** The stored times at the precision their field carries, as Unix epoch
 *  nanoseconds: 100 ns from the NTFS extra, seconds from the UT extra and the
 *  DOS field's two seconds. */
export interface RestoreTimes {
  /** Modification time, epoch nanoseconds. */
  mtimeNs: bigint;
  /** Access time, epoch nanoseconds. */
  atimeNs: bigint;
}

function filetimeToNs(ticks: bigint): bigint {
  return (ticks - NTFS_EPOCH_OFFSET) * 100n;
}

/**
 * The times in an NTFS extra's value, or null when it carries no usable
 * modification time. The value is reserved(4) followed by tagged attributes,
 * each tag(2) size(2) data; only attribute 1, whose size must be 24
 * (mtime, atime, ctime as FILETIME), holds times. A zero FILETIME means the
 * writer left the time unset, so a zero modification time makes the field
 * unusable and a zero access time falls back to the modification time.
 */
function ntfsTimes(value: Buffer): RestoreTimes | null {
  let p = 4;
  while (p + 4 <= value.length) {
    const tag = value.readUInt16LE(p);
    const size = value.readUInt16LE(p + 2);
    if (p + 4 + size > value.length) return null;
    if (tag === 0x0001) {
      if (size !== 24) return null;
      const mtime = value.readBigUInt64LE(p + 4);
      const atime = value.readBigUInt64LE(p + 12);
      if (mtime === 0n) return null;
      const mtimeNs = filetimeToNs(mtime);
      return { mtimeNs, atimeNs: atime === 0n ? mtimeNs : filetimeToNs(atime) };
    }
    p += 4 + size;
  }
  return null;
}

export function restoreTimes(entry: ReadEntry, timeZone: string): RestoreTimes {
  const ntfs = findExtra(entry.extra, 0x000a);
  const fromNtfs = ntfs ? ntfsTimes(ntfs) : null;
  if (fromNtfs) return fromNtfs;

  const ut = findExtra(entry.extra, 0x5455);
  if (ut && ut.length >= 5 && (ut[0]! & 0x01) === 0x01) {
    const ns = BigInt(ut.readInt32LE(1)) * 1_000_000_000n;
    return { mtimeNs: ns, atimeNs: ns };
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
  const ns = BigInt(ms) * 1_000_000n;
  return { mtimeNs: ns, atimeNs: ns };
}
