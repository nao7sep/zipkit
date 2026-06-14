/**
 * Container feasibility. Zip64 is needed when an entry size or a running offset
 * reaches `0xFFFFFFFF`, or the entry count reaches `0xFFFF`. The estimate is an
 * upper bound on what the writer emits — it bounds each entry's archive payload
 * (exact for `store`, a deflate upper bound for `deflate`, which can expand
 * incompressible input), counts the timestamp extras the writer adds to every
 * record, and folds in the metadata file the writer injects — so the dry run's
 * verdict is never an underestimate of the actual write. Zip64 is used
 * transparently whenever this holds and omitted otherwise; there is no policy knob.
 */

import type { WriteEntry } from "../internal/types.js";
import type { ArchivePolicy, Finding } from "../types.js";

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const LOCAL_HEADER_FIXED = 30; // local file header, fixed portion
const CENTRAL_HEADER_FIXED = 46; // central directory record, fixed portion
const EOCD_FIXED = 22; // end-of-central-directory record

/**
 * The timestamp extras the writer always emits, at their maximum size (all three
 * times present and in range): each local record carries the Info-ZIP
 * extended-timestamp extra (id+size+flags+3×4 = 17 bytes) plus the NTFS extra
 * (36); each central record carries the extended-timestamp with the modification
 * time only (9) plus the NTFS extra (36). Folding these into the estimate keeps
 * it an upper bound on the bytes the writer actually emits — without them a
 * boundary archive of stored (already-compressed) entries, where the
 * uncompressed-size over-estimate has no slack, could underreport the need. The
 * writer's tests assert the emitted sizes equal these constants, guarding drift.
 */
export const LOCAL_TIMESTAMP_EXTRA_MAX = 53;
export const CENTRAL_TIMESTAMP_EXTRA_MAX = 45;

/** The minimal shape the Zip64 estimate needs, so the plan and the writer can
 *  both feed it from their respective entry types. */
export interface SizedEntry {
  name: string; // archive name without a trailing slash
  /** Archive payload size: exact for `store`, a deflate upper bound for `deflate`. */
  size: number;
  isDir: boolean;
}

/**
 * A conservative upper bound on the deflate-compressed size of `size` bytes — the
 * shape of zlib's `deflateBound`. Deflate can *expand* incompressible input (a
 * stored block costs a few bytes per 64 KB), so a deflated entry's archive payload
 * can exceed its uncompressed size. Bounding it here means neither the Zip64
 * estimate nor the writer's per-entry header format assumes compression only
 * shrinks; `store` entries use their exact size instead.
 */
export function deflateBound(size: number): number {
  return size + Math.floor(size / 4096) + Math.floor(size / 16384) + Math.floor(size / 33554432) + 13;
}

/**
 * Whether the archive needs Zip64. The sizes, offsets, and count are compared
 * with `>=` because `0xFFFFFFFF`/`0xFFFF` are the reserved sentinels, not
 * representable values. Each `size` is an upper bound on the entry's archive
 * payload (the caller bounds deflate expansion); with the always-written
 * timestamp extras and the central directory and end record, the running total is
 * an upper bound, so the verdict is never an underestimate of the real write.
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
    localBytes += LOCAL_HEADER_FIXED + nameLen + LOCAL_TIMESTAMP_EXTRA_MAX + entry.size;
    centralBytes += CENTRAL_HEADER_FIXED + nameLen + CENTRAL_TIMESTAMP_EXTRA_MAX;
  }
  return localBytes + centralBytes + EOCD_FIXED >= U32_MAX;
}

/**
 * A safe upper bound on a string's JSON-serialized byte length. `JSON.stringify`
 * escapes a control character to `\uXXXX` — six bytes from one, its worst
 * expansion (quotes and backslashes are 2×, non-ASCII is emitted raw) — so six
 * times the UTF-8 byte length plus the surrounding quotes bounds any value.
 */
function jsonStringBytes(s: string): number {
  return 6 * Buffer.byteLength(s, "utf8") + 2;
}

// Fixed JSON allowances (pretty-printed, indent 2) for the width-bounded parts
// of the manifest — keys, punctuation, indentation, and the fields with a bounded
// width: per entry the four `{ns,iso}` time pairs, the size/compressedSize/crc32/
// mode numbers, the type/method enums, and the sha256 (64 hex); per transform,
// excluded entry, and finding the keys and small enums; and the header's fixed
// scaffolding (tool/version/createdUtc, the resolved IANA timeZone, and the
// summary/totals numbers) plus the policy's enum fields. Every *unbounded*
// variable-length string (paths, transformations, messages, comment, the policy's
// patterns/extensions/zone/name, the time-range paths) is summed separately at
// its worst-case escaped width, so the total is a true upper bound, not a
// heuristic — the few bounded strings (the IANA timeZone, enums) sit within the
// fixed allowances. A drift test measures a real metadata document against it.
const METADATA_BASE = 16384;
const METADATA_ENTRY_FIXED = 1024;
const METADATA_TRANSFORM_FIXED = 64;
const METADATA_EXCLUDED_FIXED = 512;
const METADATA_FINDING_FIXED = 512;
const METADATA_FILTER_FIXED = 64;
const METADATA_TIMERANGE_FIXED = 512;

/** The content the embedded metadata file will serialize, all known at plan
 *  time — so its size, and the Zip64 verdict that includes it, are computable
 *  before any byte is written. */
export interface MetadataContent {
  /** Written entries (the manifest's `entries`): paths and transformations. */
  entries: WriteEntry[];
  /** Dropped entries (the manifest's `excluded`). */
  excluded: { archivePath: string; originalPath: string; reason?: string }[];
  /** Every finding from the run (the manifest's `findings`). */
  findings: Finding[];
  /** The archive comment, when one was set. */
  comment?: string;
}

/** The resolved policy's variable-length strings, serialized in the manifest's
 *  `policy` block — bounded here so a run with many or long `--exclude` patterns
 *  or `--store` extensions cannot make the real manifest exceed the estimate. */
function policyStringBytes(policy: ArchivePolicy): number {
  let bytes = jsonStringBytes(policy.names.invalidCharReplacement);
  if (policy.timezone !== undefined) bytes += jsonStringBytes(policy.timezone);
  if (policy.metadata !== false) bytes += jsonStringBytes(policy.metadata.name);
  for (const filter of policy.filters) bytes += METADATA_FILTER_FIXED + jsonStringBytes(filter.pattern);
  for (const ext of policy.compression.store) bytes += jsonStringBytes(ext);
  return bytes;
}

/**
 * A real upper bound on the embedded metadata file's serialized (uncompressed)
 * size, summed from the content known at plan time: every variable-length string
 * at its worst-case JSON-escaped width plus a generous fixed allowance for each
 * record's bounded fields. Because the manifest is deflated, this also bounds its
 * compressed size in the archive. Unlike a flat per-entry heuristic it cannot be
 * beaten by long paths, many findings, or many exclude patterns — the cases that
 * would otherwise let the dry run underreport Zip64 near the 4 GiB boundary.
 */
export function estimateMetadataSize(content: MetadataContent, policy: ArchivePolicy): number {
  let bytes = METADATA_BASE + policyStringBytes(policy);
  if (content.comment !== undefined) bytes += jsonStringBytes(content.comment);

  let maxEntryPathBytes = 0;
  for (const entry of content.entries) {
    bytes += METADATA_ENTRY_FIXED;
    const pathBytes = jsonStringBytes(entry.archivePath);
    bytes += pathBytes;
    bytes += jsonStringBytes(entry.originalPath);
    bytes += jsonStringBytes(entry.sourcePath);
    if (entry.linkTarget !== undefined) bytes += jsonStringBytes(entry.linkTarget);
    for (const t of entry.transformations) {
      bytes +=
        METADATA_TRANSFORM_FIXED +
        jsonStringBytes(t.rule) +
        jsonStringBytes(t.before) +
        jsonStringBytes(t.after);
    }
    if (pathBytes > maxEntryPathBytes) maxEntryPathBytes = pathBytes;
  }
  // `timeRange` names the oldest and newest file entries; both archive paths are
  // already counted once above, so bound the second appearance by the widest.
  if (content.entries.length > 0) bytes += METADATA_TIMERANGE_FIXED + 2 * maxEntryPathBytes;

  for (const x of content.excluded) {
    bytes += METADATA_EXCLUDED_FIXED + jsonStringBytes(x.archivePath) + jsonStringBytes(x.originalPath);
    if (x.reason !== undefined) bytes += jsonStringBytes(x.reason);
  }

  for (const f of content.findings) {
    bytes +=
      METADATA_FINDING_FIXED + jsonStringBytes(f.rule) + jsonStringBytes(f.path) + jsonStringBytes(f.message);
    if (f.fix?.to !== undefined) bytes += jsonStringBytes(f.fix.to);
  }

  return bytes;
}

/**
 * Whether the archive the writer will produce needs Zip64: the planned entries
 * plus the metadata file the writer injects (when metadata is enabled), sized
 * from its real content. Shared by the plan (its `summary.zip64` verdict) and the
 * writer (its finalize decision), so the dry run and the actual write agree.
 */
export function planNeedsZip64(content: MetadataContent, policy: ArchivePolicy): boolean {
  const sized: SizedEntry[] = content.entries.map((entry) => ({
    name: entry.archivePath,
    size: entry.method === "deflate" ? deflateBound(entry.size) : entry.size,
    isDir: entry.type === "dir",
  }));
  if (policy.metadata !== false) {
    // The manifest is always deflated; bound its compressed contribution too.
    sized.push({
      name: policy.metadata.name,
      size: deflateBound(estimateMetadataSize(content, policy)),
      isDir: false,
    });
  }
  return computeZip64Need(sized);
}
