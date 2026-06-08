/**
 * Container feasibility. Zip64 is needed when an entry size or a running
 * offset reaches `0xFFFFFFFF`, or the entry count reaches `0xFFFF`. The need is
 * computed from uncompressed sizes — an upper bound, since compression only
 * shrinks data and the count is fixed — so the dry run's verdict is never an
 * underestimate of the actual write. Zip64 structures are emitted transparently
 * whenever this holds and omitted otherwise; there is no policy knob.
 */

import type { WriteEntry } from "../internal/types.js";

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const LOCAL_HEADER_FIXED = 30; // local file header, fixed portion
const CENTRAL_HEADER_FIXED = 46; // central directory record, fixed portion
const EOCD_FIXED = 22; // end-of-central-directory record

/** The minimal shape the Zip64 estimate needs, so the plan and the writer can
 *  both feed it from their respective entry types. */
export interface SizedEntry {
  name: string; // archive name without a trailing slash
  size: number; // uncompressed size
  isDir: boolean;
}

/**
 * Whether the archive needs Zip64. The sizes, offsets, and count are compared
 * with `>=` because `0xFFFFFFFF`/`0xFFFF` are the reserved sentinels, not
 * representable values. The running total is an upper bound: it uses
 * uncompressed sizes (compression only shrinks) and adds the central directory
 * and end record, so the verdict is never an underestimate of the real write.
 */
export function computeZip64Need(entries: SizedEntry[]): boolean {
  if (entries.length >= U16_MAX) return true;
  let localBytes = 0;
  let centralBytes = 0;
  for (const entry of entries) {
    if (entry.size >= U32_MAX) return true;
    if (localBytes >= U32_MAX) return true; // a local header offset reaches the limit
    const name = entry.isDir ? `${entry.name}/` : entry.name;
    const nameLen = Buffer.byteLength(name, "utf8");
    localBytes += LOCAL_HEADER_FIXED + nameLen + entry.size;
    centralBytes += CENTRAL_HEADER_FIXED + nameLen;
  }
  return localBytes + centralBytes + EOCD_FIXED >= U32_MAX;
}

/** Whether the final write-entry set needs Zip64, from uncompressed sizes. */
export function writeEntriesNeedZip64(entries: WriteEntry[]): boolean {
  return computeZip64Need(
    entries.map((entry) => ({
      name: entry.archivePath,
      size: entry.size,
      isDir: entry.type === "dir",
    })),
  );
}
