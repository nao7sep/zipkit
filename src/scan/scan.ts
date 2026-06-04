/**
 * The scan edge. It walks the source tree with `fdir`, pruning
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
 */

import { fdir } from "fdir";
import type { BigIntStats } from "node:fs";
import { lstat, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ScanError, throwIfAborted } from "../errors.js";
import type { FilterMatcher } from "../filter/match.js";
import { toForwardSlash } from "../internal/path.js";
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
}

interface ScanContext {
  matcher: FilterMatcher;
  symlinks: ArchivePolicy["symlinks"];
  followExternal: boolean;
  limit: <T>(fn: () => Promise<T>) => Promise<T>;
  signal: AbortSignal | undefined;
  logger: Logger;
  output: string;
  outputDir: string;
  outputBase: string;
  entries: ScanEntry[];
  prunedDirs: PrunedDir[];
  followedDirs: Set<string>;
  inputRoots: string[];
}

/**
 * The resolved output and the atomic-write temp file (`write-file-atomic` names
 * it `<output>.<suffix>` in the same directory) are never archived, so an
 * archive cannot contain itself or a stale temp from an interrupted run.
 */
function isOutputArtifact(ctx: ScanContext, abs: string): boolean {
  if (abs === ctx.output) return true;
  return path.dirname(abs) === ctx.outputDir && path.basename(abs).startsWith(`${ctx.outputBase}.`);
}

/**
 * The two paths an entry carries, kept together so the archive layout and the
 * disk-trace travel as one value rather than two adjacent same-typed arguments.
 * Used both as a per-entry pair and, at a directory level, as the anchor pair.
 */
interface EntryPaths {
  /** The archive path (honors `--wrap`/`--root`/`as`/flatten). */
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
    birthtimeNs: stats.birthtimeNs,
    mode: Number(stats.mode),
  };
  if (linkTarget !== undefined) entry.linkTarget = linkTarget;
  return entry;
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function isWithin(root: string, target: string): boolean {
  if (root === "") return true;
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function statBig(p: string): Promise<BigIntStats> {
  return stat(p, { bigint: true });
}

async function lstatBig(p: string): Promise<BigIntStats> {
  return lstat(p, { bigint: true });
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
    target = await readlink(abs);
  } catch {
    // Unreadable link target; record the entry with an empty target.
  }

  if (ctx.symlinks !== "follow") {
    ctx.entries.push(makeEntry(abs, inputIndex, paths, "symlink", link, target));
    return;
  }

  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    return; // broken link: nothing to follow
  }

  const root = ctx.inputRoots[inputIndex] ?? "";
  if (!ctx.followExternal && !isWithin(root, real)) return;

  let resolved: BigIntStats;
  try {
    resolved = await statBig(real);
  } catch {
    return;
  }

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
    st = await lstatBig(abs);
  } catch (err) {
    throw new ScanError("scan.stat-failed", `cannot stat: ${abs}`, { cause: err });
  }
  if (st.isSymbolicLink()) {
    await handleSymlink(ctx, abs, paths, inputIndex, st);
  } else if (st.isDirectory()) {
    ctx.entries.push(makeEntry(abs, inputIndex, paths, "dir", st));
  } else if (st.isFile()) {
    ctx.entries.push(makeEntry(abs, inputIndex, paths, "file", st));
  }
  // sockets, fifos, and devices are not archivable and are skipped silently.
}

async function crawlDirectory(
  ctx: ScanContext,
  absDir: string,
  anchors: EntryPaths,
  inputIndex: number,
): Promise<void> {
  const crawler = new fdir()
    .withFullPaths()
    .withDirs()
    .exclude((_name, dirPath) => {
      // fdir's walk is a single batch with no abort hook; pruning every
      // directory once the signal fires stops descent promptly (the result
      // loop then throws). Granularity is one directory level.
      if (ctx.signal?.aborted) return true;
      const abs = stripTrailingSlash(dirPath);
      if (abs === absDir) return false;
      const rel = path.relative(absDir, abs);
      const archive = joinArchivePath(anchors.archive, toForwardSlash(rel));
      if (archive === "") return false;
      const rule = ctx.matcher.match(archive, true);
      if (rule && rule.action === "exclude") {
        const pruned: PrunedDir = { archivePath: archive, reason: rule.describe };
        if (rule.junkRule) pruned.rule = rule.junkRule;
        ctx.prunedDirs.push(pruned);
        return true;
      }
      return false;
    })
    .crawl(absDir);

  let results: string[];
  try {
    results = await crawler.withPromise();
  } catch (err) {
    throw new ScanError("scan.walk-failed", `failed to walk directory: ${absDir}`, { cause: err });
  }

  const tasks: Promise<void>[] = [];
  for (const raw of results) {
    throwIfAborted(ctx.signal);
    const abs = stripTrailingSlash(raw);
    if (abs === absDir || isOutputArtifact(ctx, abs)) continue;
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
  const signal = spec.signal;
  throwIfAborted(signal);

  deps.logger.emit("scan", "info", "scan.start", { data: { inputs: inputs.length } });

  const root = spec.root !== undefined ? path.resolve(cwd, spec.root) : undefined;

  const isDir: boolean[] = [];
  const realInputPaths: string[] = [];
  for (const input of inputs) {
    let link: BigIntStats;
    try {
      link = await lstatBig(input.path);
    } catch (err) {
      throw new ScanError("scan.input-missing", `cannot stat input: ${input.path}`, { cause: err });
    }
    if (link.isSymbolicLink()) {
      let real: string;
      try {
        real = await realpath(input.path);
      } catch (err) {
        throw new ScanError("scan.input-missing", `cannot resolve symlink input: ${input.path}`, {
          cause: err,
        });
      }
      let resolved: BigIntStats;
      try {
        resolved = await statBig(real);
      } catch (err) {
        throw new ScanError("scan.input-missing", `cannot stat symlink target: ${input.path}`, {
          cause: err,
        });
      }
      isDir.push(resolved.isDirectory());
      realInputPaths.push(real);
    } else {
      isDir.push(link.isDirectory());
      realInputPaths.push(input.path);
    }
  }

  const anchors = inputs.map((input, i) => computeAnchor(input, isDir[i] ?? false, inputs.length, root));
  checkAnchorCollisions(inputs, anchors);

  const output = resolveOutputPath(spec.output, inputs, isDir, cwd);
  let outputExists = false;
  try {
    await stat(output);
    outputExists = true;
  } catch {
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
      canonicalRoots.push(await realpath(real));
    } catch {
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
    output,
    outputDir: path.dirname(output),
    outputBase: path.basename(output),
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
      ctx.logger.emit("scan", "debug", "scan.dir", { path: real });
      await crawlDirectory(ctx, real, anchorPaths, i);
    } else {
      if (isOutputArtifact(ctx, real)) continue;
      let fileStats: BigIntStats;
      try {
        fileStats = await statBig(real);
      } catch (err) {
        throw new ScanError("scan.input-missing", `cannot stat input file: ${real}`, { cause: err });
      }
      ctx.entries.push(makeEntry(real, i, anchorPaths, "file", fileStats));
    }
  }

  deps.logger.emit("scan", "info", "scan.done", {
    data: { entries: ctx.entries.length, prunedDirs: ctx.prunedDirs.length },
  });

  return {
    entries: ctx.entries,
    prunedDirs: ctx.prunedDirs,
    output,
    outputExists,
    overwrite: spec.overwrite === true,
  };
}
