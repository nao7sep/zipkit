/**
 * The metadata file: the serialized plan plus the raw scan data,
 * which together form a lossless record. It never stores absolute source paths
 * — only the archive-relative final and original paths, and an input-relative
 * disk-trace path. CRC-32 (already computed) detects corruption; the optional
 * SHA-256 establishes content identity; `size`/`compressedSize` record how each
 * entry compressed. Under deterministic output the volatile fields — the
 * creation time and per-entry timestamps — are omitted so the record is
 * reproducible.
 *
 * The document carries a header (tool, version, creation time, resolved policy,
 * plan summary, and aggregate byte totals), one record per written entry, the
 * list of excluded entries with their reason, and all findings. Keys follow the
 * entity-record role order: the header leads with identity and its own
 * provenance time, then config and quantities; each entry leads with identity,
 * then classification, quantity, subject attributes, and finally the nested
 * transformation list.
 */

import type { WriteEntry } from "../internal/types.js";
import type { ArchivePolicy, Plan } from "../types.js";
import { VERSION } from "../version.js";

export interface MetadataEntryInput {
  writeEntry: WriteEntry;
  crc32: number;
  /** Compressed byte length of the entry's data as written to the archive. */
  compressedSize: number;
  sha256?: string;
}

/**
 * A UTC instant as both its lossless nanosecond count and an ISO-8601 string.
 * The `ns` field is authoritative; `iso` (millisecond resolution) is for human
 * and tool readability. The ZIP fields lose precision and the DOS field its
 * zone, but this record never does.
 */
function utcTime(ns: bigint): { ns: string; iso: string } {
  return { ns: ns.toString(), iso: new Date(Number(ns / 1_000_000n)).toISOString() };
}

function metadataEntry(input: MetadataEntryInput, deterministic: boolean): Record<string, unknown> {
  const entry = input.writeEntry;
  const out: Record<string, unknown> = {
    archivePath: entry.archivePath,
    originalPath: entry.originalPath,
    // Input-relative disk-trace path: carries the input's own name even when the
    // archive path is flattened to a bare filename, so an entry stays traceable
    // to where it came from on disk. Never absolute.
    sourcePath: entry.sourcePath,
    // The writer's classification is recorded verbatim — including "symlink",
    // which the public PlannedEntry collapses to "file" — so the metadata is a
    // lossless record.
    type: entry.type,
    method: entry.method,
    size: entry.size,
    compressedSize: input.compressedSize,
  };
  if (!deterministic) {
    // All four stat times the scan captured, in UTC: modification, access,
    // inode-change, and creation. `ctime` (inode change) has no ZIP field and
    // survives only here.
    out.mtime = utcTime(entry.mtimeNs);
    out.atime = utcTime(entry.atimeNs);
    out.ctime = utcTime(entry.ctimeNs);
    // birthtime of 0 is the platform's "unavailable" marker; record null rather
    // than a fabricated creation time so the record stays honest.
    out.btime = entry.birthtimeNs > 0n ? utcTime(entry.birthtimeNs) : null;
  }
  out.crc32 = input.crc32;
  if (input.sha256 !== undefined) out.sha256 = input.sha256;
  out.mode = entry.mode;
  // A preserved symlink's target is part of the lossless record.
  if (entry.linkTarget !== undefined) out.linkTarget = entry.linkTarget;
  out.transformations = entry.transformations;
  return out;
}

export function buildMetadata(
  plan: Plan,
  policy: ArchivePolicy,
  entries: MetadataEntryInput[],
  createdNs: bigint,
  timeZone: string,
): Record<string, unknown> {
  const deterministic = policy.deterministic;
  const document: Record<string, unknown> = {
    tool: "zipkit",
    version: VERSION,
  };
  if (!deterministic) {
    document.createdUtc = utcTime(createdNs);
    // The IANA zone the archive's DOS local-time fields were rendered in, so the
    // lossy local field stays interpretable. Omitted under deterministic output,
    // where the DOS field is fixed and zone-independent.
    document.timeZone = timeZone;
  }
  document.policy = policy;
  document.summary = plan.summary;
  // Aggregate byte totals across the written entries. The on-disk archive size
  // (which also counts ZIP headers and the central directory, and for inside
  // placement would include this metadata file) is not knowable here — stat the
  // output for that; these are the content totals the writer can compute.
  document.totals = {
    uncompressedBytes: entries.reduce((sum, e) => sum + e.writeEntry.size, 0),
    compressedBytes: entries.reduce((sum, e) => sum + e.compressedSize, 0),
  };
  document.entries = entries.map((entry) => metadataEntry(entry, deterministic));
  // Dropped entries (junk, ignored symlinks, pruned directories, traversal) are
  // not in the archive, so they are recorded separately with the reason — the
  // matching rule is also in `findings`.
  document.excluded = plan.entries
    .filter((entry) => entry.excluded)
    .map((entry) => {
      const record: Record<string, unknown> = {
        archivePath: entry.archivePath,
        originalPath: entry.originalPath,
        type: entry.type,
      };
      if (entry.excludeReason !== undefined) record.reason = entry.excludeReason;
      return record;
    });
  document.findings = plan.findings;
  return document;
}
