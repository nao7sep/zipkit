/**
 * The extract/validate edge. One pass over the archive drives both: every entry
 * is decompressed and CRC-checked (so a dry run is a pure integrity test that
 * works on any ZIP); under `checkMetadata` each entry is also reconciled against
 * the manifest and its recorded SHA-256; and unless `dryRun` is set, verified
 * entries are written to disk with their times restored.
 *
 * Reads are positioned against an open fd, never a whole-archive buffer, and an
 * entry's content streams through inflate to its own output file — so memory
 * stays bounded and entries run CONCURRENTLY (bounded by the pool), each writing
 * an independent file. CRC governs writing: an entry streams to a temp file in
 * the destination, and only a CRC-clean entry that passes the path-safety,
 * exclusion, and overwrite gates is renamed into place; a corrupt entry's temp
 * file is discarded. Completeness (missing/extra) is computed from the entry-name
 * sets, independent of the decompression loop.
 */

import { createHash } from "node:crypto";
import { close, open, stat as fsStat } from "node:fs";
import { lstat, mkdir, rename, rm, symlink, utimes } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ReadError, throwIfAborted, toAbortError } from "../errors.js";
import { buildMatcher } from "../filter/match.js";
import { resolveSegments, toForwardSlash } from "../internal/path.js";
import { machineTimeZone } from "../internal/timeZone.js";
import type { Unlogged } from "../internal/types.js";
import { reportFindings } from "../log/findings.js";
import type { Logger } from "../log/logger.js";
import { finding } from "../registry.js";
import type { ExtractData, ExtractEntryResult, ExtractSpec, Finding } from "../types.js";
import { restoreTimes } from "./restore.js";
import { parseZip, readEntryBuffer, readEntryData, type ReadEntry } from "./zipReader.js";

const openAsync = promisify(open);
const closeAsync = promisify(close);
const statAsync = promisify(fsStat);

export interface ExtractDeps {
  limit: <T>(fn: () => Promise<T>) => Promise<T>;
  logger: Logger;
  chunkSize: number;
  signal?: AbortSignal;
}

interface WriteOptions {
  overwrite: boolean;
  restore: boolean;
  timeZone: string;
  symlinks: "restore" | "skip";
}

/**
 * Resolve an entry path under `dest`, or null when it would escape. Returns the
 * cleaned path segments alongside the joined target so the caller can materialize
 * the parent chain as real directories, never following a symlink.
 */
function safeJoin(dest: string, archivePath: string): { target: string; segments: string[] } | null {
  const { segments, escaped } = resolveSegments(toForwardSlash(archivePath));
  if (escaped || segments.length === 0) return null;
  const target = path.join(dest, ...segments);
  if (escapesDest(dest, target)) return null;
  return { target, segments };
}

/** Whether `candidate` falls outside `dest` — a sibling, an ancestor, or an
 *  absolute path elsewhere. Used for entry paths and for a restored symlink's
 *  resolved target. The component check (`..` then a separator) avoids flagging a
 *  legitimate name that merely starts with two dots (`..config`). */
function escapesDest(dest: string, candidate: string): boolean {
  const rel = path.relative(dest, candidate);
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/** The outcome of materializing one verified entry on disk. `unsafe` means a
 *  symlink in the entry's path — or an escaping link target — would let it land
 *  outside `dest`; the entry is then written nowhere. */
type CommitOutcome = "written" | "exists" | "unsafe";

/**
 * Create `dest/<segments>` as real directories, one component at a time, never
 * following or creating *through* a symlink. Returns false when an existing
 * component is a symlink — the symlink-indirected zip-slip case — so the caller
 * writes nothing through it. The component-wise (non-recursive) `mkdir` is what
 * makes this safe: a recursive `mkdir` resolves a planted symlink in the chain
 * and would write outside `dest`. A real file occupying a directory slot is a
 * genuine conflict and is thrown, surfacing as a write fault as before.
 */
async function ensureRealDirs(dest: string, segments: string[]): Promise<boolean> {
  let current = dest;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await mkdir(current);
      continue; // freshly created as a real directory
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    // It already existed (or a sibling entry just created it): it must be a real
    // directory, not a symlink an earlier entry or the pre-existing tree planted.
    const st = await lstat(current);
    if (st.isSymbolicLink()) return false;
    if (!st.isDirectory()) {
      throw new Error(`cannot create directory ${current}: a non-directory already exists`);
    }
  }
  return true;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

interface ManifestRecord {
  archivePath?: unknown;
  sha256?: unknown;
}

/** The verified outcome of streaming one entry through inflate. */
interface VerifyResult {
  crcOk: boolean;
  sha?: ExtractEntryResult["sha"];
  /** A staged temp file holding the verified bytes, when one was written. */
  tempPath?: string;
  /** A symlink's decoded target, when the entry is a symlink to be restored. */
  linkTarget?: string;
}

/**
 * Stream an entry through inflate, verifying its CRC and (under checkMetadata)
 * its SHA-256. When `stageTo` is given the bytes are written to that temp path
 * so a CRC-clean entry can later be renamed into place; otherwise the entry is
 * verified against a null sink (dry-run, excluded, unsafe, or skipped). A
 * symlink's small target is captured in memory regardless, for the symlink call.
 */
async function verifyEntry(
  fd: number,
  entry: ReadEntry,
  chunkSize: number,
  checkSha: boolean,
  storedSha: string | null,
  stageTo: string | null,
  captureLink: boolean,
  signal: AbortSignal | undefined,
): Promise<VerifyResult> {
  if (entry.type === "dir") {
    return { crcOk: true, sha: checkSha ? (storedSha ? "ok" : "absent") : undefined };
  }

  const hasher = checkSha ? createHash("sha256") : null;
  const linkChunks: Buffer[] = [];
  const out = stageTo ? createWriteStream(stageTo) : null;

  const sink = async (chunk: Buffer): Promise<void> => {
    throwIfAborted(signal);
    if (hasher) hasher.update(chunk);
    if (captureLink) linkChunks.push(chunk);
    if (out) {
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
    }
  };

  let crc32: number;
  try {
    ({ crc32 } = await readEntryData(fd, entry, sink, chunkSize));
  } catch (err) {
    if (out) {
      // The staging stream is being discarded (the read aborted or failed). A
      // write queued before the failure may complete after destroy and emit
      // ERR_STREAM_DESTROYED — swallow it, since the temp file is removed anyway.
      out.on("error", () => {});
      out.destroy();
      await rm(stageTo as string, { force: true });
    }
    throw err;
  }
  if (out) {
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  const crcOk = crc32 === (entry.crc32 >>> 0);
  const result: VerifyResult = { crcOk };
  if (checkSha) {
    if (storedSha === null) result.sha = "absent";
    else result.sha = hasher!.digest("hex") === storedSha ? "ok" : "mismatch";
  }
  if (crcOk && stageTo) result.tempPath = stageTo;
  if (captureLink) result.linkTarget = Buffer.concat(linkChunks).toString("utf8");
  return result;
}

/** Create a directory entry: its whole chain, as real directories. */
async function commitDir(dest: string, segments: string[]): Promise<CommitOutcome> {
  return (await ensureRealDirs(dest, segments)) ? "written" : "unsafe";
}

/** Move a verified temp file into its final place, restoring times. The parent
 *  chain is created as real directories first; a symlinked ancestor is `unsafe`. */
async function commitFile(
  dest: string,
  parentSegments: string[],
  entry: ReadEntry,
  tempPath: string,
  target: string,
  options: WriteOptions,
): Promise<CommitOutcome> {
  if (!(await ensureRealDirs(dest, parentSegments))) {
    await rm(tempPath, { force: true });
    return "unsafe";
  }
  if (!options.overwrite && (await pathExists(target))) {
    await rm(tempPath, { force: true });
    return "exists";
  }
  await rename(tempPath, target);
  if (options.restore) {
    const t = restoreTimes(entry, options.timeZone);
    // Best-effort: a filesystem that rejects the times must not fail the write.
    try {
      await utimes(target, new Date(t.atimeMs), new Date(t.mtimeMs));
    } catch {
      /* times are advisory; the content is what matters */
    }
  }
  return "written";
}

export async function extractArchive(
  spec: ExtractSpec,
  deps: ExtractDeps,
): Promise<Unlogged<ExtractData>> {
  const signal = deps.signal;
  throwIfAborted(signal);

  const write = spec.dryRun !== true;
  if (write && (spec.dest === undefined || spec.dest === "")) {
    throw new ReadError(
      "read.no-dest",
      "extract requires a destination directory unless dryRun is set",
      { usage: true },
    );
  }
  const timeZone = spec.timezone ?? machineTimeZone();
  const writeOptions: WriteOptions = {
    overwrite: spec.overwrite === true,
    restore: (spec.timestamps ?? "restore") === "restore",
    timeZone,
    symlinks: spec.symlinks ?? "restore",
  };
  const onUnsafe = spec.onUnsafe ?? "skip";
  // The same exclusion engine the archive side uses; no junk preset on read.
  const matcher = buildMatcher(spec.exclude ?? [], false);
  const dest = spec.dest !== undefined ? path.resolve(spec.dest) : undefined;

  let fd: number;
  let fileSize: number;
  try {
    fd = await openAsync(spec.archive, "r");
    fileSize = (await statAsync(spec.archive)).size;
  } catch (err) {
    throw new ReadError("read.open-failed", `cannot read archive ${spec.archive}`, {
      cause: err,
      usage: true,
    });
  }

  try {
    const parsed = await parseZip(fd, fileSize);
    deps.logger.emit({
      stage: "extract",
      level: "info",
      event: "extract.start",
      entries: parsed.entries.length,
      write,
    });

    // Manifest resolution (heavy mode): the manifest is the entry embedded in
    // the archive, read via positioned reads. Requested-but-absent is a hard
    // failure.
    let manifest: ExtractData["manifest"] = null;
    let manifestEntryPath: string | undefined;
    const manifestMap = new Map<string, ManifestRecord>();
    if (spec.checkMetadata) {
      const name = spec.metadataName ?? "_metadata.json";
      const inside = parsed.entries.find((e) => e.archivePath === name);
      if (!inside) {
        throw new ReadError(
          "read.manifest-missing",
          `metadata validation requested but no manifest '${name}' is embedded in the archive`,
        );
      }
      manifestEntryPath = inside.archivePath;
      let doc: { entries?: unknown };
      try {
        doc = JSON.parse((await readEntryBuffer(fd, inside)).toString("utf8"));
      } catch (err) {
        throw new ReadError("read.manifest-invalid", `manifest ${name} is not valid JSON`, {
          cause: err,
        });
      }
      manifest = { name };
      const docEntries = Array.isArray(doc.entries) ? (doc.entries as ManifestRecord[]) : [];
      for (const m of docEntries) {
        if (typeof m.archivePath === "string") manifestMap.set(m.archivePath, m);
      }
    }

    if (write && dest !== undefined) await mkdir(dest, { recursive: true });

    // Per-entry processing runs concurrently — each entry streams to its own
    // output file. `aborted` short-circuits the pool once an `onUnsafe: abort`
    // entry is found, so the run fails fast without spawning the rest.
    const abort: { entry: ReadEntry | null } = { entry: null };
    // `allSettled`, not `all`: every task runs to completion so none is abandoned
    // mid-stream — which would orphan its temp file and keep reading the archive
    // descriptor the `finally` is about to close. Failures are surfaced after.
    const settled = await Promise.allSettled(
      parsed.entries.map((entry) =>
        deps.limit(async () => {
          throwIfAborted(signal);
          if (abort.entry) return null;
          return processEntry(entry);
        }),
      ),
    );
    for (const s of settled) {
      if (s.status === "rejected") throw s.reason;
    }
    if (abort.entry) {
      throw new ReadError(
        "read.unsafe-path",
        `entry '${abort.entry.archivePath}' escapes the destination directory`,
      );
    }

    async function processEntry(entry: ReadEntry): Promise<ExtractEntryResult> {
      const isManifestEntry = entry.archivePath === manifestEntryPath;
      const checkSha = spec.checkMetadata === true && entry.type !== "dir" && !isManifestEntry;
      const record = checkSha ? manifestMap.get(entry.archivePath) : undefined;
      const storedSha =
        record && typeof record.sha256 === "string" ? record.sha256 : null;

      // Decide up front whether this entry's bytes are written, so we only stage
      // a temp file when it will actually be committed. Everything else still
      // streams (CRC and SHA are verified) but to a null sink.
      let skip: ExtractEntryResult["skipped"];
      let target: string | null = null;
      let segments: string[] = [];
      if (!write) {
        skip = "dry-run";
      } else if (matcher.match(entry.archivePath, entry.type === "dir")) {
        skip = "excluded";
      } else {
        const joined = safeJoin(dest as string, entry.archivePath);
        if (joined === null) {
          skip = "unsafe";
          if (onUnsafe === "abort") abort.entry ??= entry;
        } else if (entry.type === "symlink" && writeOptions.symlinks === "skip") {
          skip = "symlink-skip";
        } else {
          target = joined.target;
          segments = joined.segments;
        }
      }

      const willWrite = target !== null && entry.type !== "dir";
      const tempPath =
        willWrite && entry.type !== "symlink"
          ? path.join(dest as string, `.zk-${process.pid}-${randomTag()}.tmp`)
          : null;
      const captureLink = entry.type === "symlink";

      const verified = await verifyEntry(
        fd,
        entry,
        deps.chunkSize,
        checkSha,
        storedSha,
        tempPath,
        captureLink,
        signal,
      );

      let didWrite = false;
      let outputPath: string | undefined;
      if (!verified.crcOk) {
        // A corrupt entry is never written. CRC failure outranks every reason
        // except a dry run, where writing was never on the table.
        if (skip !== "dry-run") skip = "crc-fail";
        if (verified.tempPath) await rm(verified.tempPath, { force: true });
      } else if (target !== null) {
        let outcome: CommitOutcome;
        try {
          // The entry is verified but not yet published. Honor a cancellation
          // that arrived since its last streamed chunk so no file lands after
          // the abort instant — relevant under concurrency, where a sibling
          // entry may still be streaming.
          throwIfAborted(signal);
          if (entry.type === "dir") {
            outcome = await commitDir(dest as string, segments);
          } else if (entry.type === "symlink") {
            outcome = await commitSymlink(
              dest as string,
              segments.slice(0, -1),
              target,
              verified.linkTarget ?? "",
              writeOptions,
            );
          } else {
            outcome = await commitFile(
              dest as string,
              segments.slice(0, -1),
              entry,
              verified.tempPath as string,
              target,
              writeOptions,
            );
          }
        } catch (err) {
          if (verified.tempPath) await rm(verified.tempPath, { force: true });
          // An abort is control flow, not a write fault: let it propagate as an
          // AbortError rather than mislabeling it read.write-failed (exit 5).
          if (signal?.aborted) throw toAbortError(signal.reason);
          throw new ReadError("read.write-failed", `cannot write ${entry.archivePath}`, {
            cause: err,
          });
        }
        if (outcome === "written") {
          didWrite = true;
          outputPath = target;
        } else if (outcome === "exists") {
          skip = "exists";
        } else {
          // A symlink in the path, or a symlink whose target escapes dest, would
          // land the entry outside the destination: treated exactly like a
          // lexical path escape (an unsafe skip, honoring onUnsafe: abort).
          skip = "unsafe";
          if (onUnsafe === "abort") abort.entry ??= entry;
        }
      }

      const result: ExtractEntryResult = {
        archivePath: entry.archivePath,
        type: entry.type,
        crc: verified.crcOk ? "ok" : "fail",
        written: didWrite,
      };
      if (verified.sha !== undefined) result.sha = verified.sha;
      if (skip !== undefined) result.skipped = skip;
      if (outputPath !== undefined) result.outputPath = outputPath;
      deps.logger.emit({
        stage: "extract",
        level: "debug",
        event: "entry.verified",
        path: entry.archivePath,
      });
      return result;
    }

    const entries: ExtractEntryResult[] = settled
      .map((s) => (s as PromiseFulfilledResult<ExtractEntryResult | null>).value)
      .filter((r): r is ExtractEntryResult => r !== null);
    const findings: Finding[] = [];
    const seen = new Set<string>();
    let crcFailed = 0;
    let shaMismatched = 0;
    let unsafe = 0;
    let written = 0;
    let skipped = 0;

    for (const r of entries) {
      if (r.archivePath !== manifestEntryPath) seen.add(r.archivePath);
      if (r.crc === "fail") {
        crcFailed++;
        findings.push(
          finding("extract.crc-fail", r.archivePath, "CRC-32 mismatch: entry is corrupt", {
            severity: "error",
          }),
        );
      }
      if (r.sha === "mismatch") {
        shaMismatched++;
        findings.push(
          finding("extract.sha-mismatch", r.archivePath, "content hash does not match the manifest", {
            severity: "error",
          }),
        );
      }
      if (r.skipped === "unsafe") {
        unsafe++;
        findings.push(
          finding(
            "extract.unsafe-path",
            r.archivePath,
            "entry would resolve outside the destination directory (path traversal or unsafe symlink)",
            { severity: "error" },
          ),
        );
      }
      if (r.written) written++;
      else skipped++;
    }

    const missing: string[] = [];
    const extra: string[] = [];
    if (spec.checkMetadata) {
      for (const key of manifestMap.keys()) if (!seen.has(key)) missing.push(key);
      for (const key of seen) if (!manifestMap.has(key)) extra.push(key);
      for (const m of missing) {
        findings.push(
          finding("extract.missing", m, "entry is in the manifest but absent from the archive", {
            severity: "error",
          }),
        );
      }
      for (const e of extra) {
        findings.push(
          finding("extract.extra", e, "entry is in the archive but absent from the manifest", {
            severity: "warning",
          }),
        );
      }
    }

    const reportOk =
      crcFailed === 0 &&
      unsafe === 0 &&
      (!spec.checkMetadata || (missing.length === 0 && extra.length === 0 && shaMismatched === 0));

    // Enumerate the failures before the aggregate: one warn/error line per
    // finding (CRC failure, SHA mismatch, unsafe path, missing/extra entry), so a
    // corrupt or tampered archive logs *which* entries failed, not just a count.
    // The per-success "entry.verified" lines stay at debug.
    reportFindings(deps.logger, "extract", findings);

    deps.logger.emit({
      stage: "extract",
      level: "info",
      event: "extract.done",
      total: entries.length,
      crcFailed,
      shaMismatched,
      written,
      skipped,
      reportOk,
    });

    return {
      archive: spec.archive,
      dest: write && spec.dest !== undefined ? spec.dest : null,
      dryRun: !write,
      wrote: written > 0,
      reportOk,
      manifest,
      summary: { total: entries.length, written, skipped, crcFailed, shaMismatched },
      entries,
      missing,
      extra,
      findings,
    };
  } finally {
    await closeAsync(fd).catch(() => {});
  }
}

/** Restore a symlink. A link whose target resolves outside `dest`, or one whose
 *  parent chain crosses a symlink, is `unsafe` and never created — restoring it
 *  would leave an escape hatch a later entry (or the user) could write through.
 *  `exists` means an existing target was preserved. */
async function commitSymlink(
  dest: string,
  parentSegments: string[],
  target: string,
  linkTarget: string,
  options: WriteOptions,
): Promise<CommitOutcome> {
  const resolved = path.resolve(path.dirname(target), linkTarget);
  if (escapesDest(dest, resolved)) return "unsafe";
  if (!(await ensureRealDirs(dest, parentSegments))) return "unsafe";
  if (!options.overwrite && (await pathExists(target))) return "exists";
  if (options.overwrite) await rm(target, { force: true });
  await symlink(linkTarget, target);
  return "written"; // link times are not restored: no portable lutimes guarantee
}

let tagCounter = 0;
/** A short, collision-resistant suffix for a per-entry temp file. */
function randomTag(): string {
  tagCounter = (tagCounter + 1) >>> 0;
  return `${Date.now().toString(36)}-${tagCounter.toString(36)}`;
}
