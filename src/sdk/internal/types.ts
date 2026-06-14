/**
 * Internal types shared across the scan → plan → write layers. None of these
 * are part of the committed surface; they may be refactored freely.
 *
 * Time is carried as nanoseconds since the Unix epoch (UTC) in a `bigint`,
 * matching the precision the platform stat call exposes and the metadata
 * file's lossless record. Conversion to DOS time happens only at the
 * writer's edge.
 */

import type { RuleId } from "../registry.js";

/**
 * A verb result before the SDK boundary stamps the session-log path onto it. The
 * pure builders (`planArchive`, `writeArchive`, `extractArchive`) produce
 * everything a result holds *except* `log`; {@link import("../zipkit.js").ZipKit}
 * adds it where it owns the per-session log, so the builders stay
 * logging-agnostic.
 */
export type Unlogged<T> = Omit<T, "log">;

/** Raw metadata for one filesystem object, produced by the scan layer. */
export interface ScanEntry {
  /** Absolute source path on disk. Internal only; never serialized. */
  absolutePath: string;
  /** Index into the resolved input list this entry was produced from. */
  inputIndex: number;
  /**
   * Pre-fix archive path: the input's resolved anchor joined with the entry's
   * path relative to that input. Forward slashes, relative, no leading slash.
   */
  archivePath: string;
  /**
   * A best-effort disk-trace path: the input's own name (as the user supplied
   * it) joined with the entry's path within that input, independent of the
   * archive layout, so a flattened entry is not reduced to a bare filename in
   * the metadata. Always relative and never absolute or `..`-escaping, so the
   * clean-byte guarantee holds — but a trace hint, not a unique key: distinct
   * inputs sharing a basename can yield the same sourcePath, and a
   * filesystem-root input ("/") contributes no name. Recorded in the metadata.
   */
  sourcePath: string;
  type: "file" | "dir" | "symlink";
  size: number;
  /**
   * The four nanosecond stat times the platform exposes, all UTC instants:
   * modification, access, inode-change, and creation (birth). `ctimeNs` (inode
   * change) has no ZIP field and rides only into the metadata record; the
   * others map to the DOS field and the timestamp extras. Birth time is not
   * tracked on every filesystem; the platform then reports 0 (or a fallback),
   * so a zero `birthtimeNs` is treated as "no creation time" — omitted from the
   * UT extra, written as the FILETIME unset sentinel in NTFS, and null in the
   * metadata — rather than preserved as if real.
   */
  mtimeNs: bigint;
  atimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
  mode: number;
  /** For symlinks: the raw link target as read from disk. */
  linkTarget?: string;
}

/** A directory whose subtree the walk pruned because a filter excluded it. */
export interface PrunedDir {
  archivePath: string;
  /** The junk rule that pruned it, when the prune came from the junk preset. */
  rule?: RuleId;
  reason: string;
}

/** Everything the pure planner needs, gathered by the scan edge. */
export interface ScanResult {
  entries: ScanEntry[];
  prunedDirs: PrunedDir[];
  output: string;
  outputExists: boolean;
  overwrite: boolean;
  /** The archive comment from the spec, carried through to the writer. */
  comment?: string;
}

/** One name fix applied to an entry, recorded for the metadata file. */
export interface Transformation {
  rule: RuleId;
  before: string;
  after: string;
}

/**
 * An entry the writer will emit. Produced by the planner alongside the public
 * {@link import("../types.js").PlannedEntry}, but retaining the absolute source
 * path and raw attributes the writer and metadata builder need. Carried out of
 * band on the plan (see `carrier.ts`) so it never reaches serialization.
 */
export interface WriteEntry {
  archivePath: string; // final, NFC, forward-slash, relative
  originalPath: string; // pre-fix archive path
  sourcePath: string; // input-relative disk-trace path (see ScanEntry.sourcePath)
  type: "file" | "dir" | "symlink";
  method: "store" | "deflate";
  absolutePath: string; // "" for synthetic directory entries
  size: number;
  mtimeNs: bigint;
  atimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
  mode: number;
  linkTarget?: string;
  transformations: Transformation[];
}
