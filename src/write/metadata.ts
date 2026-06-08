/**
 * The metadata record: the serialized plan plus the raw scan data, which
 * together form a lossless account of the run. It never stores absolute source
 * paths — only the archive-relative final and original paths, and an
 * input-relative disk-trace path. CRC-32 (already computed) detects corruption;
 * the optional SHA-256 establishes content identity; `size`/`compressedSize`
 * record how each entry compressed. The full record is always built and
 * returned from `create`; it is embedded as `_metadata.json` unless disabled.
 *
 * The document carries a header (tool, version, creation time, the zone the DOS
 * fields used, resolved policy, plan summary, and aggregate byte totals), one
 * record per written entry, the list of excluded entries with their reason, and
 * all findings. Keys follow the entity-record role order: the header leads with
 * identity and its own provenance time, then config and quantities; each entry
 * leads with identity, then classification, quantity, subject attributes, and
 * finally the nested transformation list.
 */

import type { WriteEntry } from "../internal/types.js";
import type {
  ArchivePolicy,
  CreateData,
  ExtremeEntry,
  Metadata,
  MetadataEntry,
  MetadataExcluded,
  UtcTime,
} from "../types.js";
import { VERSION } from "../version.js";

/** The `mode:"plan"` member of {@link CreateData} — the planning view the
 *  metadata document is built from (entries, summary, findings). */
type PlanData = Extract<CreateData, { mode: "plan" }>;

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
function utcTime(ns: bigint): UtcTime {
  return { ns: ns.toString(), iso: new Date(Number(ns / 1_000_000n)).toISOString() };
}

function metadataEntry(input: MetadataEntryInput): MetadataEntry {
  const entry = input.writeEntry;
  const record: MetadataEntry = {
    archivePath: entry.archivePath,
    // Input-relative disk-trace path: carries the input's own name even when the
    // archive path is flattened to a bare filename, so an entry stays traceable
    // to where it came from on disk. Never absolute.
    originalPath: entry.originalPath,
    sourcePath: entry.sourcePath,
    // The writer's classification is recorded verbatim — including "symlink",
    // which the public PlannedEntry collapses to "file" — so the record is lossless.
    type: entry.type,
    method: entry.method,
    size: entry.size,
    compressedSize: input.compressedSize,
    crc32: input.crc32,
    mode: entry.mode,
    // All four stat times the scan captured, in UTC: modification, access,
    // inode-change, and creation. `ctime` (inode change) has no ZIP field and
    // survives only here. A birthtime of 0 is the platform's "unavailable"
    // marker — recorded as null rather than a fabricated creation time.
    mtime: utcTime(entry.mtimeNs),
    atime: utcTime(entry.atimeNs),
    ctime: utcTime(entry.ctimeNs),
    btime: entry.birthtimeNs > 0n ? utcTime(entry.birthtimeNs) : null,
    transformations: entry.transformations,
  };
  if (input.sha256 !== undefined) record.sha256 = input.sha256;
  // A preserved symlink's target is part of the lossless record.
  if (entry.linkTarget !== undefined) record.linkTarget = entry.linkTarget;
  return record;
}

/**
 * The modification-time span of the archived file set: the oldest and newest
 * entries by `mtime`. Synthetic directories carry a stat time too but are not
 * "files", so only file and symlink entries count. Ties go to the first entry in
 * plan order, keeping the result deterministic. `null` when the set holds no such
 * entry, so a caller can read the span without re-deriving it from `entries`.
 */
function computeTimeRange(entries: MetadataEntryInput[]): Metadata["timeRange"] {
  let oldest: { entry: ExtremeEntry; ns: bigint } | null = null;
  let newest: { entry: ExtremeEntry; ns: bigint } | null = null;
  for (const { writeEntry } of entries) {
    if (writeEntry.type === "dir") continue;
    const ns = writeEntry.mtimeNs;
    if (oldest === null || ns < oldest.ns) {
      oldest = { entry: { archivePath: writeEntry.archivePath, mtime: utcTime(ns) }, ns };
    }
    if (newest === null || ns > newest.ns) {
      newest = { entry: { archivePath: writeEntry.archivePath, mtime: utcTime(ns) }, ns };
    }
  }
  if (oldest === null || newest === null) return null;
  return { oldest: oldest.entry, newest: newest.entry };
}

export function buildMetadata(
  plan: PlanData,
  policy: ArchivePolicy,
  entries: MetadataEntryInput[],
  createdNs: bigint,
  timeZone: string,
  comment?: string,
): Metadata {
  const excluded: MetadataExcluded[] = plan.entries
    .filter((entry) => entry.excluded)
    .map((entry) => {
      const record: MetadataExcluded = {
        archivePath: entry.archivePath,
        originalPath: entry.originalPath,
        type: entry.type,
      };
      if (entry.excludeReason !== undefined) record.reason = entry.excludeReason;
      return record;
    });

  const document: Metadata = {
    tool: "zipkit",
    version: VERSION,
    createdUtc: utcTime(createdNs),
    // The IANA zone the archive's DOS local-time fields were rendered in, so the
    // lossy local field stays interpretable.
    timeZone,
    policy,
    summary: plan.summary,
    // Aggregate byte totals across the written entries. The on-disk archive size
    // (which also counts ZIP headers, the central directory, and this embedded
    // metadata file) is not knowable here — stat the output for that; these are
    // the content totals the writer can compute.
    totals: {
      uncompressedBytes: entries.reduce((sum, e) => sum + e.writeEntry.size, 0),
      compressedBytes: entries.reduce((sum, e) => sum + e.compressedSize, 0),
    },
    timeRange: computeTimeRange(entries),
    entries: entries.map(metadataEntry),
    // Dropped entries (junk, ignored symlinks, pruned directories, traversal) are
    // not in the archive, so they are recorded separately with the reason — the
    // matching rule is also in `findings`.
    excluded,
    findings: plan.findings,
  };
  // The comment rides into the document only when set, so a commentless archive
  // does not carry an empty field.
  if (comment !== undefined) document.comment = comment;
  return document;
}
