/**
 * The scan edge. It walks the source tree, pruning
 * excluded directory subtrees through the shared matcher during the walk, and
 * reads each entry's nanosecond timestamps, mode, and symlink target with a
 * direct stat call. It also performs the two I/O facts the pure planner needs
 * but cannot compute: the resolved output path and whether it already exists.
 *
 * Arcname logic lives in the pure `arcname` module and is applied here, so the
 * walk and the plan share one source of archive-path truth. Symlinks are
 * surfaced as `"symlink"` entries for `ignore`/`preserve`; under `follow` they
 * are dereferenced here, guarded against cycles (a visited real-path set) and
 * against escaping the input tree unless `followExternal` is set. A symlink
 * given directly as a top-level input is always followed, as it is explicit.
 *
 * Every filesystem call goes through the run's bounded {@link Volume}, so a
 * source on a stalled volume fails the scan with a `StallError` naming the
 * path instead of hanging it. The places that deliberately tolerate a failed
 * call (an unreadable link, a broken link, an unreadable subdirectory) tolerate
 * only a filesystem refusal, never a stall or a cancel.
 */

import type { BigIntStats } from "node:fs";
import path from "node:path";
import { ScanError, throwIfAborted, ZipKitError } from "../errors.js";
import type { FilterMatcher } from "../filter/match.js";
import { toForwardSlash } from "../internal/path.js";
import type { Volume } from "../internal/volume.js";
import type { PrunedDir, ScanEntry, ScanResult } from "../internal/types.js";
import type { Logger } from "../log/logger.js";
import {
  checkAnchorCollisions,
  computeAnchor,
  joinArchivePath,
  normalizeInputs,
} from "../plan/arcname.js";
import { resolveOutputPath } from "./output.js";
import type { ArchivePolicy, ArchiveSpec } from "../types.js";

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
   * line either way. (The metadata is embedded, so there is no second output
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
  followedDirs: Set<string>;
  inputRoots: string[];
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

function isWithin(root: string, target: string): boolean {
  if (root === "") return true;
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Rethrow a stall or a cancel from a call whose ordinary failure is tolerated. */
function rethrowClassified(err: unknown): void {
  if (err instanceof ZipKitError) throw err;
}

async function handleSymlink(
  ctx: ScanContext,
  abs: string,
  paths: EntryPaths,
  inputIndex: number,
  link: BigIntStats,
): Promise<void> {
  let target = "";
  try {
    target = await ctx.volume.readlink(abs);
  } catch (err) {
    rethrowClassified(err);
    // Unreadable link target; record the entry with an empty target. Trace it at
    // debug — a recovered-from anomaly during the walk, not a fault worth a sink.
    ctx.logger.emit({ stage: "scan", level: "debug", event: "scan.symlink-unreadable", path: abs });
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
    return; // broken link: nothing to follow
  }

  const root = ctx.inputRoots[inputIndex] ?? "";
  if (!ctx.followExternal && !isWithin(root, real)) return;

  let resolved: BigIntStats;
  try {
    resolved = await ctx.volume.stat(real);
  } catch (err) {
    rethrowClassified(err);
    return;
  }
  // A followed symlink carries the target's bytes, so self-exclusion must compare
  // the resolved target identity too (the link inode itself is necessarily
  // different from the output inode).
  if (ctx.artifactIds.has(fileId(resolved))) return;

  if (resolved.isDirectory()) {
    // Check and claim with no await in between, so concurrent symlinks to the
    // same real directory cannot both pass the cycle guard.
    if (ctx.followedDirs.has(real)) return;
    ctx.followedDirs.add(real);
    await crawlDirectory(ctx, real, paths, inputIndex);
  } else if (resolved.isFile()) {
    ctx.entries.push(makeEntry(real, inputIndex, paths, "file", resolved));
  }
}

async function processPath(
  ctx: ScanContext,
  abs: string,
  paths: EntryPaths,
  inputIndex: number,
): Promise<void> {
  let st: BigIntStats;
  try {
    st = await ctx.volume.lstat(abs);
  } catch (err) {
    rethrowClassified(err);
    throw new ScanError("scan.stat-failed", `cannot stat: ${abs}`, { cause: err });
  }
  // This run's own output archive, reached under any casing: skip it so the
  // archive can never contain itself.
  if (ctx.artifactIds.has(fileId(st))) return;
  if (st.isSymbolicLink()) {
    await handleSymlink(ctx, abs, paths, inputIndex, st);
  } else if (st.isDirectory()) {
    ctx.entries.push(makeEntry(abs, inputIndex, paths, "dir", st));
  } else if (st.isFile()) {
    ctx.entries.push(makeEntry(abs, inputIndex, paths, "file", st));
  }
  // sockets, fifos, and devices are not archivable and are skipped silently.
}

/** How many directories the walk lists at once. */
const WALK_BATCH = 16;

/**
 * Walk a directory tree breadth-first, listing each directory through the
 * bounded volume and pruning excluded subtrees through the shared matcher
 * before descending into them. Returns every path under `absDir` (not
 * `absDir` itself). A symlink is listed, never descended into; following one
 * is `handleSymlink`'s decision. A subdirectory that cannot be listed is
 * skipped, while a stall or a cancel ends the scan. Only the input root
 * itself failing to list is a scan fault.
 */
async function walkTree(ctx: ScanContext, absDir: string, anchors: EntryPaths): Promise<string[]> {
  const found: string[] = [];
  let level = [absDir];
  while (level.length > 0) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += WALK_BATCH) {
      throwIfAborted(ctx.signal);
      const batch = level.slice(i, i + WALK_BATCH);
      const listings = await Promise.all(
        batch.map(async (dir) => {
          try {
            return { dir, entries: await ctx.volume.readdir(dir) };
          } catch (err) {
            rethrowClassified(err);
            if (dir === absDir) {
              throw new ScanError("scan.walk-failed", `failed to walk directory: ${absDir}`, { cause: err });
            }
            return { dir, entries: [] };
          }
        }),
      );
      for (const { dir, entries } of listings) {
        for (const entry of entries) {
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const archive = joinArchivePath(anchors.archive, toForwardSlash(path.relative(absDir, abs)));
            const rule = archive === "" ? null : ctx.matcher.match(archive, true);
            if (rule) {
              const pruned: PrunedDir = { archivePath: archive, reason: rule.describe };
              if (rule.junkRule) pruned.rule = rule.junkRule;
              ctx.prunedDirs.push(pruned);
              continue;
            }
            next.push(abs);
          }
          found.push(abs);
        }
      }
    }
    level = next;
  }
  return found;
}

async function crawlDirectory(
  ctx: ScanContext,
  absDir: string,
  anchors: EntryPaths,
  inputIndex: number,
): Promise<void> {
  const results = await walkTree(ctx, absDir, anchors);

  const tasks: Promise<void>[] = [];
  for (const abs of results) {
    throwIfAborted(ctx.signal);
    const fwdRel = toForwardSlash(path.relative(absDir, abs));
    const archive = joinArchivePath(anchors.archive, fwdRel);
    if (archive === "") continue;
    const source = joinArchivePath(anchors.source, fwdRel);
    tasks.push(ctx.limit(() => processPath(ctx, abs, { archive, source }, inputIndex)));
  }
  await Promise.all(tasks);
}

export async function scan(
  spec: ArchiveSpec,
  policy: ArchivePolicy,
  deps: ScanDeps,
): Promise<ScanResult> {
  const cwd = process.cwd();
  const inputs = normalizeInputs(spec.inputs, cwd);
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
      rethrowClassified(err);
      throw new ScanError("scan.input-missing", `cannot stat input: ${input.path}`, {
        cause: err,
      });
    }
    if (link.isSymbolicLink()) {
      let real: string;
      try {
        real = await deps.volume.realpath(input.path);
      } catch (err) {
        rethrowClassified(err);
        throw new ScanError("scan.input-missing", `cannot resolve symlink input: ${input.path}`, {
          cause: err,
        });
      }
      let resolved: BigIntStats;
      try {
        resolved = await deps.volume.stat(real);
      } catch (err) {
        rethrowClassified(err);
        throw new ScanError("scan.input-missing", `cannot stat symlink target: ${input.path}`, {
          cause: err,
        });
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

  const output = resolveOutputPath(spec.output, inputs, isDir, cwd);
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
      throw new ScanError(
        "scan.output-is-input",
        `output archive is the same physical file as input: ${inputs[sameInput]?.path ?? output}`,
      );
    }
    artifactIds.add(outputId);
  } catch (err) {
    rethrowClassified(err);
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ScanError("scan.output-stat-failed", `cannot inspect output path: ${output}`, {
        cause: err,
      });
    }
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
    if (!isDir[i]) {
      canonicalRoots.push(real);
      continue;
    }
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
    };
    if (isDir[i]) {
      ctx.logger.emit({ stage: "scan", level: "debug", event: "scan.dir", path: real });
      await crawlDirectory(ctx, real, anchorPaths, i);
    } else {
      let fileStats: BigIntStats;
      try {
        fileStats = await deps.volume.stat(real);
      } catch (err) {
        rethrowClassified(err);
        throw new ScanError("scan.input-missing", `cannot stat input file: ${real}`, {
          cause: err,
        });
      }
      // A file named directly as input that is itself the output archive.
      if (ctx.artifactIds.has(fileId(fileStats))) continue;
      ctx.entries.push(makeEntry(real, i, anchorPaths, "file", fileStats));
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
    output,
    outputExists,
    overwrite: spec.overwrite === true,
  };
  if (spec.comment !== undefined) result.comment = spec.comment;
  return result;
}
