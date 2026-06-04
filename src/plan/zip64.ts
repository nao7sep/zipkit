/**
 * Container feasibility (§11). Zip64 is needed when an entry size or a running
 * offset reaches `0xFFFFFFFF`, or the entry count reaches `0xFFFF`. The need is
 * computed from uncompressed sizes — an upper bound, since compression only
 * shrinks data and the count is fixed — so the dry run's verdict is never an
 * underestimate of the actual write.
 *
 * `auto` (default) and `always` use Zip64 and warn (`compat.zip64`), because
 * the pre-Windows-10 built-in reader cannot open it. `never` turns a triggering
 * archive into an error (`compat.zip64-required`), since it cannot be
 * represented in 32-bit fields.
 */

import path from "node:path";
import { finding } from "../registry.js";
import type { WriteEntry } from "../internal/types.js";
import type { ArchivePolicy, Finding } from "../types.js";

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

function toSizedEntries(entries: WriteEntry[]): SizedEntry[] {
  return entries.map((entry) => ({
    name: entry.archivePath,
    size: entry.size,
    isDir: entry.type === "dir",
  }));
}

export function applyZip64(
  entries: WriteEntry[],
  policy: ArchivePolicy,
  output: string,
  globalFindings: Finding[],
): boolean {
  // The locator is the archive's basename, not the absolute output path, so a
  // container-level finding never carries an absolute path into the metadata.
  const locator = path.basename(output);

  if (policy.zip64 === "always") {
    globalFindings.push(
      finding(
        "compat.zip64",
        locator,
        "Zip64 is always enabled; the pre-Windows-10 built-in reader cannot open it",
      ),
    );
    return true;
  }

  const needed = computeZip64Need(toSizedEntries(entries));

  if (policy.zip64 === "never") {
    if (needed) {
      globalFindings.push(
        finding(
          "compat.zip64-required",
          locator,
          "the archive exceeds 32-bit ZIP limits but Zip64 is disabled",
        ),
      );
    }
    return false;
  }

  if (needed) {
    globalFindings.push(
      finding(
        "compat.zip64",
        locator,
        "Zip64 is required and enabled; the pre-Windows-10 built-in reader cannot open it",
      ),
    );
  }
  return needed;
}
