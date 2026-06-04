/**
 * Internal types shared across the scan → plan → write layers. None of these
 * are part of the committed surface (§6); they may be refactored freely.
 *
 * Time is carried as nanoseconds since the Unix epoch (UTC) in a `bigint`,
 * matching the precision the platform stat call exposes and the metadata
 * file's lossless record (§10.10). Conversion to DOS time happens only at the
 * writer's edge.
 */

import type { RuleId } from "../registry.js";

/** Raw metadata for one filesystem object, produced by the scan layer. */
export interface ScanEntry {
  /** Absolute source path on disk. Internal only; never serialized (§8). */
  absolutePath: string;
  /** Index into the resolved input list this entry was produced from. */
  inputIndex: number;
  /**
   * Pre-fix archive path: the input's resolved anchor joined with the entry's
   * path relative to that input. Forward slashes, relative, no leading slash.
   */
  archivePath: string;
  type: "file" | "dir" | "symlink";
  size: number;
  mtimeNs: bigint;
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
}

/** One name fix applied to an entry, recorded for the metadata file (§10.10). */
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
  type: "file" | "dir" | "symlink";
  method: "store" | "deflate";
  absolutePath: string; // "" for synthetic directory entries
  size: number;
  mtimeNs: bigint;
  birthtimeNs: bigint;
  mode: number;
  linkTarget?: string;
  transformations: Transformation[];
}
