/**
 * Internal types shared across the scan → plan → write layers. None of these
 * are part of the committed surface; they may be refactored freely.
 *
 * Time is carried as nanoseconds since the Unix epoch (UTC) in a `bigint`,
 * matching the precision the platform stat call exposes and the manifest
 * file's lossless record. Conversion to DOS time happens only at the
 * writer's edge.
 */

import type { SegmentIssue } from "../plan/nameFix.ts";
import type { NameFix, UnsupportedKind } from "../types.ts";

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
   * the manifest. Always relative and never absolute or `..`-escaping, so the
   * clean-byte guarantee holds — but a trace hint, not a unique key: distinct
   * inputs sharing a basename can yield the same sourcePath, and a
   * filesystem-root input ("/") contributes no name. Recorded in the manifest.
   */
  sourcePath: string;
  /** Where it is on disk as the user sees it: the input as given joined with
   *  the entry's path inside it, through followed links (`absolutePath` is
   *  what is read, a followed link's target). Public on the planned entry. */
  diskPath: string;
  type: "file" | "dir" | "symlink";
  size: number;
  /**
   * The four nanosecond stat times the platform exposes, all UTC instants:
   * modification, access, inode-change, and creation (birth). `ctimeNs` (inode
   * change) has no ZIP field and rides only into the manifest record; the
   * others map to the DOS field and the timestamp extras. Birth time is not
   * tracked on every filesystem; the platform then reports 0 (or a fallback),
   * so a zero `birthtimeNs` is treated as "no creation time" — omitted from the
   * UT extra, written as the FILETIME unset sentinel in NTFS, and null in the
   * manifest — rather than preserved as if real.
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
  diskPath: string;
  reason: string;
}

/** Why the walk left an object out that it found: ZIP stores only files,
 *  folders and links, and a link under `follow` must lead to one of those. */
export type SkipKind = UnsupportedKind;

/** An object the walk found and left out, recorded so the plan can report it. */
export interface SkippedEntry {
  archivePath: string;
  sourcePath: string;
  diskPath: string;
  kind: SkipKind;
}

/** Everything the pure planner needs, gathered by the scan edge. */
export interface ScanResult {
  entries: ScanEntry[];
  prunedDirs: PrunedDir[];
  /** Objects found but not archivable (see {@link SkippedEntry}). */
  skipped: SkippedEntry[];
  /** Archive paths of folders below an input whose listing failed, so their
   *  contents are missing from the scan. */
  unlistedDirs: string[];
  output: string;
  outputExists: boolean;
  /** The archive's name as resolved, before any fix, and what its check found
   *  (see `plan/outputName.ts`). */
  outputNaming: { before: string; issues: SegmentIssue[] };
  overwrite: boolean;
  /** The IANA zone the DOS local-time fields are rendered in: the policy's
   *  zone or, without one, the host's. Resolved once here so the plan's DOS-range
   *  findings and the writer's clamping use the same zone. */
  timeZone: string;
  /** The archive comment from the spec, carried through to the writer. */
  comment?: string;
}

/** One name fix applied to an entry, recorded for the manifest file. */
export type { NameFix } from "../types.ts";

/**
 * An entry the writer will emit. Produced by the planner alongside the public
 * {@link import("../types.ts").PlannedEntry}, but retaining the absolute source
 * path and raw attributes the writer and manifest builder need. A plan carries
 * it as plain data (see `instructions.ts`).
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
  nameFixes: NameFix[];
}
