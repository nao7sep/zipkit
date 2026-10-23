/**
 * The scan edge. It walks the source tree, pruning
 * excluded directory subtrees through the shared matcher during the walk, and
 * reads each entry's nanosecond timestamps, mode, and symlink target with a
 * direct stat call. It also gathers the environment facts the pure planner
 * needs but cannot compute: the resolved output path, whether it already
 * exists, and the zone the DOS time fields are rendered in.
 *
 * Arcname logic lives in the pure `arcname` module and is applied here, so the
 * walk and the plan share one source of archive-path truth. Symlinks are
 * surfaced as `"symlink"` entries for `ignore`/`preserve`; under `follow` they
 * are dereferenced here, guarded against cycles (a visited real-path set) and
 * against escaping the input tree unless `followExternal` is set. A symlink
 * given directly as a top-level input is always followed, as it is explicit.
 *
 * Every filesystem call goes through the run's bounded {@link Volume}, so a
 * source on a stalled volume fails the scan with a `io.stalled` error naming the
 * path instead of hanging it. The places that deliberately tolerate a failed
 * call (an unreadable link, a broken link, an unreadable subdirectory) tolerate
 * only a filesystem refusal, never a stall or a cancel.
 */

import type { BigIntStats } from "node:fs";
import path from "node:path";
import { workerCount } from "../internal/bounded-map.ts";
import { fsFailure, throwIfAborted, ZipKitError } from "../errors.ts";
import type { FilterMatcher } from "../filter/match.ts";
import { isWithin } from "../internal/path.ts";
import { machineTimeZone } from "../internal/timeZone.ts";
import type { DirEntry, Volume } from "../internal/volume.ts";
import type { PrunedDir, ScanEntry, ScanResult, SkipKind, SkippedEntry } from "../internal/types.ts";
import type { Logger } from "../log/logger.ts";
import {
  checkAnchorCollisions,
  computeAnchor,
  joinArchivePath,
  normalizeInputs,
} from "../plan/arcname.ts";
import { resolveOutputPath } from "./output.ts";
import { checkOutputName } from "../plan/outputName.ts";
import type { ArchivePolicy, ArchiveSpec } from "../types.ts";

export interface ScanDeps {
  matcher: FilterMatcher;
  limit: <T>(fn: () => Promise<T>) => Promise<T>;
  logger: Logger;
  signal: AbortSignal | undefined;
  /** The run's bounded file access, built with the same signal. */
  volume: Volume;
}

interface ScanContext {
  matcher: FilterMatcher;
  symlinks: ArchivePolicy["symlinks"];
  followExternal: boolean;
  limit: <T>(fn: () => Promise<T>) => Promise<T>;
  signal: AbortSignal | undefined;
  logger: Logger;
  volume: Volume;
  /**
   * File identity (`dev:ino`) of this run's own output archive, when it already
   * exists on disk. Compared against the identity of each walked entry so the
   * run never archives itself, exactly on every filesystem: a case-insensitive
   * volume aliases `Out.zip`/`out.zip` to one inode, while a case-sensitive one
   * keeps a same-named neighbour distinct. A name comparison could not draw that
   * line either way. (The manifest is embedded, so there is no second output
   * file to exclude.)
   *
   * This is the only self-exclusion the scan does. There is deliberately no
   * name-based "looks like an atomic-write temp" rule: the current run's temp
   * never exists during the scan (the scan completes before any write), and a
   * stale temp survives only a hard crash that skipped the writer's rename and
   * cleanup — rare, and harmlessly archived as an ordinary file. Guessing from
   * the name instead would silently drop a real neighbour such as a dated
   * `archive.zip.20240604`, which is the worse failure.
   */
  artifactIds: Set<string>;
  entries: ScanEntry[];
  prunedDirs: PrunedDir[];
  skipped: SkippedEntry[];
  unlistedDirs: string[];
  followedDirs: Set<string>;
  inputRoots: string[];
  /** First failure closes admission while issued logical work is joined. */
  failure?: { error: unknown };
}

/** A path's filesystem identity: same file ⇔ same `dev:ino`, regardless of how
 * the name is cased or which link reached it. */
function fileId(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}`;
}

/**
 * The two paths an entry carries, kept together so the archive layout and the
 * disk-trace travel as one value rather than two adjacent same-typed arguments.
 * Used both as a per-entry pair and, at a directory level, as the anchor pair.
 */
interface EntryPaths {
  /** The archive path (single-dir flatten, else basename-anchored per input). */
  archive: string;
  /** The input-relative disk-trace path (see {@link ScanEntry.sourcePath}). */
  source: string;
  /** Where it is on disk, from the input as given (see {@link ScanEntry.diskPath}). */
  disk: string;
}

function makeEntry(
  absolutePath: string,
  inputIndex: number,
  paths: EntryPaths,
  type: ScanEntry["type"],
  stats: BigIntStats,
  linkTarget?: string,
): ScanEntry {
  const entry: ScanEntry = {
    absolutePath,
    inputIndex,
    archivePath: paths.archive,
    sourcePath: paths.source,
    diskPath: paths.disk,
    type,
    size: Number(stats.size),
    mtimeNs: stats.mtimeNs,
    atimeNs: stats.atimeNs,
    ctimeNs: stats.ctimeNs,
    birthtimeNs: stats.birthtimeNs,
    mode: Number(stats.mode),
  };
  if (linkTarget !== undefined) entry.linkTarget = linkTarget;
  return entry;
}

/** The kind of a stat'd object that is neither a file, a folder nor a link. */
function specialKind(stats: BigIntStats): SkipKind {
  if (stats.isSocket()) return "socket";
  if (stats.isFIFO()) return "fifo";
  return "device";
}

function skip(ctx: ScanContext, paths: EntryPaths, kind: SkipKind): void {
  ctx.skipped.push({ archivePath: paths.archive, sourcePath: paths.source, diskPath: paths.disk, kind });
}

function checkFailure(ctx: ScanContext): void {
  if (ctx.failure) throw ctx.failure.error;
}

/** Rethrow a stall or a cancel from a call whose ordinary failure is tolerated. */
function rethrowClassified(err: unknown): void {
  if (err instanceof ZipKitError) throw err;
}

interface FollowedDirectory {
  real: string;
  paths: EntryPaths;
  inputIndex: number;
}

async function handleSymlink(
  ctx: ScanContext,
  abs: string,
  paths: EntryPaths,
  inputIndex: number,
  link: BigIntStats,
): Promise<FollowedDirectory | void> {
  let target: string | undefined;
  if (ctx.symlinks === "preserve") {
    try { target = await ctx.volume.readlink(abs); }
    catch (error) { throw fsFailure(error, abs); }
  }

  if (ctx.symlinks !== "follow") {
    ctx.entries.push(makeEntry(abs, inputIndex, paths, "symlink", link, target));
    return;
  }

  let real: string;
  try {
    real = await ctx.volume.realpath(abs);
  } catch (err) {
    rethrowClassified(err);
    skip(ctx, paths, "broken-link"); // nothing to follow
    return;
  }

  const root = ctx.inputRoots[inputIndex] ?? "";
  if (!ctx.followExternal && root !== "" && !isWithin(root, real)) {
    skip(ctx, paths, "external-link");
    return;
  }

  let resolved: BigIntStats;
  try {
    resolved = await ctx.volume.stat(real);
  } catch (err) {
    rethrowClassified(err);
    skip(ctx, paths, "unreadable-link");
    return;
  }
  // A followed symlink carries the target's bytes, so self-exclusion must compare
  // the resolved target identity too (the link inode itself is necessarily
  // different from the output inode). Silent: the target is the archive itself.
  if (ctx.artifactIds.has(fileId(resolved))) return;

  if (resolved.isDirectory()) {
    // Check and claim with no await in between, so concurrent symlinks to the
    // same real directory cannot both pass the cycle guard. A repeat visit is
    // silent: the first visit already archived that content.
    if (ctx.followedDirs.has(real)) return;
    ctx.followedDirs.add(real);
    ctx.entries.push(makeEntry(real, inputIndex, paths, "dir", resolved));
    return { real, paths, inputIndex };
  } else if (resolved.isFile()) {
    ctx.entries.push(makeEntry(real, inputIndex, paths, "file", resolved));
  } else {
    skip(ctx, paths, specialKind(resolved));
  }
}

async function processPath(
  ctx: ScanContext,
  abs: string,
  paths: EntryPaths,
  inputIndex: number,
): Promise<FollowedDirectory | void> {
  let st: BigIntStats;
  try {
    st = await ctx.volume.lstat(abs);
  } catch (err) {
    throw fsFailure(err, abs);
  }
  // This run's own output archive, reached under any casing: skip it so the
  // archive can never contain itself.
  if (ctx.artifactIds.has(fileId(st))) return;
  if (st.isSymbolicLink()) {
    return handleSymlink(ctx, abs, paths, inputIndex, st);
  } else if (st.isDirectory()) {
    ctx.entries.push(makeEntry(abs, inputIndex, paths, "dir", st));
    return { real: abs, paths, inputIndex };
  } else if (st.isFile()) {
    ctx.entries.push(makeEntry(abs, inputIndex, paths, "file", st));
  } else {
    // Sockets, FIFOs and devices cannot be archived; the plan reports each.
    skip(ctx, paths, specialKind(st));
  }
}

/** Stream one directory and admit only one batch of stat work. Descendants run
 * after the batch releases its slots, so nested links cannot deadlock the shared
 * pool. Open directory handles follow traversal depth rather than tree width. */
async function crawlDirectory(ctx: ScanContext, absDir: string, anchors: EntryPaths, inputIndex: number, required = true): Promise<void> {
  checkFailure(ctx);
  throwIfAborted(ctx.signal);
  const iterator = ctx.volume.directoryEntries(absDir);
  const count = workerCount(ctx.limit);
  let done = false;
  let failed = false;
  try {
    while (!done) {
      checkFailure(ctx);
      throwIfAborted(ctx.signal);
      const batch: DirEntry[] = [];
      while (batch.length < count && !done) {
        try {
          const next = await iterator.next();
          if (next.done) done = true;
          else batch.push(next.value);
        } catch (error) {
          throwIfAborted(ctx.signal);
          if (required || error instanceof ZipKitError) throw fsFailure(error, absDir);
          ctx.unlistedDirs.push(anchors.archive);
          done = true;
        }
      }
      if (batch.length === 0) break;
      const results = await Promise.allSettled(batch.map((entry) => ctx.limit(async () => {
        const paths = {
          archive: joinArchivePath(anchors.archive, entry.name),
          source: joinArchivePath(anchors.source, entry.name),
          disk: path.join(anchors.disk, entry.name),
        };
        const rule = entry.isDirectory() ? ctx.matcher.match(paths.archive, true) : null;
        if (rule) {
          ctx.prunedDirs.push({ archivePath: paths.archive, diskPath: paths.disk, reason: rule.describe, excludedBy: rule.excludedBy });
          return;
        }
        return processPath(ctx, path.join(absDir, entry.name), paths, inputIndex);
      })));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") { ctx.failure = { error: failure.reason }; throw failure.reason; }
      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          const next = result.value;
          await crawlDirectory(ctx, next.real, next.paths, next.inputIndex, false);
        }
      }
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await iterator.return(undefined); }
    catch (error) { if (!failed) throw error; }
  }
}

export async function scan(
  spec: ArchiveSpec,
  policy: ArchivePolicy,
  deps: ScanDeps,
): Promise<ScanResult> {
  const inputs = normalizeInputs(spec.inputs);
  const signal = deps.signal;
  throwIfAborted(signal);

  deps.logger.emit({ stage: "scan", level: "info", event: "scan.start", inputs: inputs.length });

  const isDir: boolean[] = [];
  const realInputPaths: string[] = [];
  const inputStats: BigIntStats[] = [];
  for (const input of inputs) {
    let link: BigIntStats;
    try {
      link = await deps.volume.lstat(input.path);
    } catch (err) {
      throw fsFailure(err, input.path);
    }
    if (link.isSymbolicLink()) {
      let real: string;
      try {
        real = await deps.volume.realpath(input.path);
      } catch (err) {
        throw fsFailure(err, input.path);
      }
      let resolved: BigIntStats;
      try {
        resolved = await deps.volume.stat(real);
      } catch (err) {
        throw fsFailure(err, input.path);
      }
      isDir.push(resolved.isDirectory());
      realInputPaths.push(real);
      inputStats.push(resolved);
    } else {
      isDir.push(link.isDirectory());
      realInputPaths.push(input.path);
      inputStats.push(link);
    }
  }

  const anchors = inputs.map((input, i) => computeAnchor(input, isDir[i] ?? false, inputs.length));
  checkAnchorCollisions(inputs, anchors);

  const resolved = resolveOutputPath(spec, inputs, isDir);
  const outputName = checkOutputName(resolved.path, resolved.inferred, policy.names);
  const output = outputName.path;
  // The identities of this run's own output files, used to exclude them from the
  // walk by file identity rather than by name (see `ScanContext.artifactIds`).
  const artifactIds = new Set<string>();
  let outputExists = false;
  try {
    const outputLink = await deps.volume.lstat(output);
    outputExists = true;
    const outputStats = outputLink.isSymbolicLink() ? await deps.volume.stat(output) : outputLink;
    const outputId = fileId(outputStats);
    const sameInput = inputStats.findIndex((input) => fileId(input) === outputId);
    if (sameInput !== -1) {
      throw new ZipKitError(
        "scan.output-is-input",
        `output archive is the same physical file as input: ${inputs[sameInput]?.path ?? output}`,
        { subject: output },
      );
    }
    artifactIds.add(outputId);
  } catch (err) {
    rethrowClassified(err);
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw fsFailure(err, output);
    outputExists = false;
  }

  // The containment root and the cycle seed are compared against the realpath of
  // symlink targets discovered during the walk, so they must live in the same
  // canonical space. Canonicalizing here keeps an internal symlink from looking
  // external (and being dropped under follow) merely because an ancestor of the
  // input is itself a symlink — the macOS /tmp -> /private/tmp link being the
  // common case. The crawl base and the resolved output stay in the caller's
  // path space, so output self-exclusion and the returned output string are
  // unaffected.
  const canonicalRoots: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const real = realInputPaths[i] as string;
    try {
      canonicalRoots.push(await deps.volume.realpath(real));
    } catch (err) {
      rethrowClassified(err);
      canonicalRoots.push(real);
    }
  }

  const ctx: ScanContext = {
    matcher: deps.matcher,
    symlinks: policy.symlinks,
    followExternal: policy.followExternal,
    limit: deps.limit,
    signal,
    logger: deps.logger,
    volume: deps.volume,
    artifactIds,
    entries: [],
    prunedDirs: [],
    skipped: [],
    unlistedDirs: [],
    followedDirs: new Set(),
    inputRoots: canonicalRoots,
  };
  for (let i = 0; i < inputs.length; i++) {
    if (isDir[i]) ctx.followedDirs.add(canonicalRoots[i] as string);
  }

  for (let i = 0; i < inputs.length; i++) {
    throwIfAborted(signal);
    const real = realInputPaths[i] as string;
    // The source anchor carries the input's own name as the user supplied it
    // (`inputs[i].path`, not the realpath), so sourcePath traces to disk, stays
    // consistent with the archive anchor, and does not leak a symlink target's
    // name even when the archive anchor is flattened away.
    const anchorPaths: EntryPaths = {
      archive: anchors[i] ?? "",
      source: path.basename(inputs[i]?.path ?? real),
      disk: inputs[i]?.path ?? real,
    };
    if (isDir[i]) {
      if (anchorPaths.archive !== "") {
        const rule = ctx.matcher.match(anchorPaths.archive, true);
        if (rule) {
          ctx.prunedDirs.push({ archivePath: anchorPaths.archive, diskPath: anchorPaths.disk, reason: rule.describe, excludedBy: rule.excludedBy });
          continue;
        }
        ctx.entries.push(makeEntry(real, i, anchorPaths, "dir", inputStats[i]!));
      }
      ctx.logger.emit({ stage: "scan", level: "debug", event: "scan.dir", path: real });
      await crawlDirectory(ctx, real, anchorPaths, i);
    } else {
      let fileStats: BigIntStats;
      try {
        fileStats = await deps.volume.stat(real);
      } catch (err) {
        throw fsFailure(err, real);
      }
      // A file named directly as input that is itself the output archive.
      if (ctx.artifactIds.has(fileId(fileStats))) continue;
      if (fileStats.isFile()) ctx.entries.push(makeEntry(real, i, anchorPaths, "file", fileStats));
      else skip(ctx, anchorPaths, specialKind(fileStats));
    }
  }

  deps.logger.emit({
    stage: "scan",
    level: "info",
    event: "scan.done",
    entries: ctx.entries.length,
    prunedDirs: ctx.prunedDirs.length,
  });

  const result: ScanResult = {
    entries: ctx.entries,
    prunedDirs: ctx.prunedDirs,
    skipped: ctx.skipped,
    unlistedDirs: ctx.unlistedDirs,
    output,
    outputExists,
    outputNaming: { before: resolved.path, issues: outputName.issues },
    overwrite: spec.overwrite === true,
    timeZone: policy.timeZone ?? machineTimeZone(),
  };
  if (spec.comment !== undefined) result.comment = spec.comment;
  return result;
}
