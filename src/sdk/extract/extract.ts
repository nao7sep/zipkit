/**
 * The extract/validate edge. One pass over the archive drives both: every entry
 * is decompressed and CRC-checked (so a dry run is a pure integrity test that
 * works on any ZIP); under `checkMetadata` each entry is also reconciled against
 * the manifest and its recorded SHA-256; and unless `dryRun` is set, verified
 * entries are written to disk with their times restored.
 *
 * Reads are positioned against an open handle, never a whole-archive buffer, and an
 * entry's content streams through inflate to its own output file — so memory
 * stays bounded and entries run CONCURRENTLY (bounded by the pool), each writing
 * an independent file. CRC governs writing: an entry streams to a temp file in
 * the destination, and only a CRC-clean entry that passes the path-safety,
 * exclusion, and overwrite gates is renamed into place; a corrupt entry's temp
 * file is discarded. Completeness (missing/extra) is computed from the entry-name
 * sets, independent of the decompression loop.
 *
 * Every filesystem call goes through the run's bounded {@link Volume}, so an
 * archive or destination on a stalled volume fails the run with a
 * `StallError` instead of hanging it.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { nanoid } from "nanoid";
import { AbortError, ReadError, StallError, throwIfAborted, toAbortError, ZipKitError } from "../errors.js";
import { buildMatcher } from "../filter/match.js";
import { resolveSegments, toForwardSlash } from "../internal/path.js";
import { machineTimeZone } from "../internal/timeZone.js";
import type { Unlogged } from "../internal/types.js";
import { reportFindings } from "../log/findings.js";
import type { Logger } from "../log/logger.js";
import { publishNoOverwrite, volumePublishOperations } from "../internal/noClobberPublish.js";
import type { Volume, VolumeFile } from "../internal/volume.js";
import { METADATA_DEFAULTS } from "../policy.js";
import { finding } from "../registry.js";
import type { ExtractData, ExtractEntryResult, ExtractSpec, Finding } from "../types.js";
import { restoreTimes } from "./restore.js";
import { findTargetCollision } from "./targetCollision.js";
import { parseZip, readEntryBuffer, readEntryData, type ReadEntry } from "./zipReader.js";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_SYMLINK_TARGET_BYTES = 64 * 1024;

export interface ExtractDeps {
  limit: <T>(fn: () => Promise<T>) => Promise<T>;
  logger: Logger;
  chunkSize: number;
  signal?: AbortSignal;
  /** The run's bounded file access, built with the same signal. */
  volume: Volume;
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
async function ensureRealDirs(volume: Volume, dest: string, segments: string[]): Promise<boolean> {
  let current = dest;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await volume.mkdir(current);
      continue; // freshly created as a real directory
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    // It already existed (or a sibling entry just created it): it must be a real
    // directory, not a symlink an earlier entry or the pre-existing tree planted.
    const st = await volume.lstat(current);
    if (st.isSymbolicLink()) return false;
    if (!st.isDirectory()) {
      throw new Error(`cannot create directory ${current}: a non-directory already exists`);
    }
  }
  return true;
}

/** One `entries` record of an embedded manifest, as untrusted JSON. */
export interface ManifestRecord {
  archivePath?: unknown;
  sourcePath?: unknown;
  type?: unknown;
  size?: unknown;
  crc32?: unknown;
  sha256?: unknown;
  mtime?: unknown;
}

/** Find and parse the embedded manifest `name` among an open archive's entries.
 *  Absent is `read.manifest-missing`; unparseable is `read.manifest-invalid`. */
async function loadManifest(
  archive: VolumeFile,
  entries: ReadEntry[],
  name: string,
): Promise<{ entry: ReadEntry; records: ManifestRecord[] }> {
  const inside = entries.find((e) => e.archivePath === name);
  if (!inside) {
    throw new ReadError(
      "read.manifest-missing",
      `metadata validation requested but no manifest '${name}' is embedded in the archive`,
    );
  }
  let doc: { entries?: unknown };
  try {
    doc = JSON.parse((await readEntryBuffer(archive, inside, MAX_MANIFEST_BYTES)).toString("utf8"));
  } catch (err) {
    if (err instanceof StallError || err instanceof AbortError) throw err;
    throw new ReadError("read.manifest-invalid", `manifest ${name} is not valid JSON`, {
      cause: err,
    });
  }
  const records = Array.isArray(doc?.entries) ? (doc.entries as ManifestRecord[]) : [];
  return { entry: inside, records: records.filter((r) => typeof r === "object" && r !== null) };
}

/** Open an archive and read its embedded manifest's entry records. */
export async function readManifest(volume: Volume, archivePath: string, name: string): Promise<ManifestRecord[]> {
  let archive: VolumeFile;
  try {
    archive = await volume.open(archivePath, "r");
  } catch (err) {
    if (err instanceof ZipKitError) throw err;
    throw new ReadError("read.open-failed", `cannot read archive ${archivePath}`, { cause: err });
  }
  try {
    let fileSize: number;
    try {
      fileSize = Number((await archive.stat()).size);
    } catch (err) {
      if (err instanceof ZipKitError) throw err;
      throw new ReadError("read.open-failed", `cannot read archive ${archivePath}`, { cause: err });
    }
    const parsed = await parseZip(archive, fileSize);
    return (await loadManifest(archive, parsed.entries, name)).records;
  } finally {
    await archive.release();
  }
}

/**
 * Whether a manifest record's size or CRC-32 disagrees with the archive's
 * central directory. A field the record does not hold as a number (an older or
 * third-party manifest) is not compared, so it is never a mismatch.
 */
function recordMismatches(record: ManifestRecord, entry: ReadEntry): boolean {
  if (typeof record.size === "number" && record.size !== entry.uncompSize) return true;
  if (typeof record.crc32 === "number" && record.crc32 >>> 0 !== entry.crc32 >>> 0) return true;
  return false;
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
  volume: Volume,
  archive: VolumeFile,
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
  if (captureLink && entry.uncompSize > MAX_SYMLINK_TARGET_BYTES) {
    throw new ReadError(
      "read.entry-too-large",
      `${entry.archivePath} exceeds the symlink target size limit`,
    );
  }

  const hasher = checkSha ? createHash("sha256") : null;
  const linkChunks: Buffer[] = [];
  const out = stageTo ? await volume.open(stageTo, "w") : null;

  const sink = async (chunk: Buffer): Promise<void> => {
    throwIfAborted(signal);
    if (hasher) hasher.update(chunk);
    if (captureLink) linkChunks.push(chunk);
    if (out) await out.writeAll(chunk, null);
  };

  let crc32: number;
  try {
    ({ crc32 } = await readEntryData(archive, entry, sink, chunkSize));
    if (out) await out.close();
  } catch (err) {
    if (out) {
      // The staged bytes are discarded (the read or a write failed, stalled, or
      // was cancelled); the cleanup is bounded and still runs after a cancel.
      await out.release();
      await volume.discard(stageTo as string);
    }
    throw err;
  }

  const crcOk = crc32 === (entry.crc32 >>> 0);
  if (!crcOk && stageTo) await volume.discard(stageTo);
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
async function commitDir(volume: Volume, dest: string, segments: string[]): Promise<CommitOutcome> {
  return (await ensureRealDirs(volume, dest, segments)) ? "written" : "unsafe";
}

/** Move a verified temp file into its final place, restoring times. The parent
 *  chain is created as real directories first; a symlinked ancestor is `unsafe`. */
async function commitFile(
  volume: Volume,
  dest: string,
  parentSegments: string[],
  entry: ReadEntry,
  tempPath: string,
  target: string,
  options: WriteOptions,
  signal: AbortSignal | undefined,
): Promise<CommitOutcome> {
  if (!(await ensureRealDirs(volume, dest, parentSegments))) {
    await volume.discard(tempPath);
    return "unsafe";
  }
  // not recorded: this is extracted archive content written to the user's chosen destination — output
  // (arbitrary, often binary) the app writes for the user and then forgets, not managed state the app
  // reloads. It lives outside `~/.zipkit/` and is not captured by the data-backup layer (data-backup
  // conventions). The SDK is also a separate layer with no dependency on the GUI's backup store.
  if (options.overwrite) {
    await volume.publishRename(tempPath, target);
  } else {
    try {
      await publishNoOverwrite(tempPath, target, signal, volumePublishOperations(volume));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        await volume.discard(tempPath);
        return "exists";
      }
      throw err;
    }
  }
  if (options.restore) {
    const t = restoreTimes(entry, options.timeZone);
    // Best-effort: a filesystem that rejects the times must not fail the write.
    // A stall or a cancel is not such a rejection and still ends the run.
    try {
      await volume.utimes(target, new Date(t.atimeMs), new Date(t.mtimeMs));
    } catch (err) {
      if (err instanceof ZipKitError) throw err;
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

  const volume = deps.volume;
  let archive: VolumeFile;
  try {
    archive = await volume.open(spec.archive, "r");
  } catch (err) {
    if (err instanceof ZipKitError) throw err;
    throw new ReadError("read.open-failed", `cannot read archive ${spec.archive}`, {
      cause: err,
    });
  }

  try {
    let fileSize: number;
    try {
      fileSize = Number((await archive.stat()).size);
    } catch (err) {
      if (err instanceof ZipKitError) throw err;
      throw new ReadError("read.open-failed", `cannot read archive ${spec.archive}`, {
        cause: err,
      });
    }
    const parsed = await parseZip(archive, fileSize);
    deps.logger.emit({
      stage: "extract",
      level: "info",
      event: "extract.start",
      entries: parsed.entries.length,
      write,
    });

    const collision = findTargetCollision(parsed.entries);
    if (collision) {
      throw new ReadError(
        "read.target-collision",
        `entries '${collision[0]}' and '${collision[1]}' resolve to colliding extraction targets`,
      );
    }

    // Manifest resolution (heavy mode): the manifest is the entry embedded in
    // the archive, read via positioned reads. Requested-but-absent is a hard
    // failure.
    let manifest: ExtractData["manifest"] = null;
    let manifestEntryPath: string | undefined;
    const manifestMap = new Map<string, ManifestRecord>();
    if (spec.checkMetadata) {
      const name = spec.metadataName ?? METADATA_DEFAULTS.name;
      const loaded = await loadManifest(archive, parsed.entries, name);
      manifestEntryPath = loaded.entry.archivePath;
      manifest = { name };
      for (const m of loaded.records) {
        if (typeof m.archivePath === "string") manifestMap.set(m.archivePath, m);
      }
    }

    if (write && dest !== undefined) await volume.mkdir(dest, true);

    // Per-entry processing runs concurrently — each entry streams to its own
    // output file. `aborted` short-circuits the pool once an `onUnsafe: abort`
    // entry is found, so the run fails fast without spawning the rest.
    const abort: { entry: ReadEntry | null } = { entry: null };
    // Entries whose size or CRC-32 differs from their manifest record.
    const manifestMismatches = new Set<string>();
    // `allSettled`, not `all`: every task runs to completion so none is abandoned
    // mid-stream — which would orphan its temp file and keep reading the archive
    // handle the `finally` is about to close. Each task's calls are bounded, and
    // once one stalls the volume refuses the rest, so this wait is bounded too.
    // Failures are surfaced after, a stall ahead of the refusals it caused.
    const settled = await Promise.allSettled(
      parsed.entries.map((entry) =>
        deps.limit(async () => {
          throwIfAborted(signal);
          if (abort.entry) return null;
          return processEntry(entry);
        }),
      ),
    );
    const failures = settled.flatMap((s) => (s.status === "rejected" ? [s.reason as unknown] : []));
    const failure = failures.find((f) => f instanceof StallError) ?? failures[0];
    if (failure !== undefined) throw failure;
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
      // The archive's own header is all the CRC check compares against, so a
      // replaced entry passes it; comparing the central directory's size and
      // CRC-32 with the manifest catches it even without a recorded SHA-256.
      if (record && recordMismatches(record, entry)) manifestMismatches.add(entry.archivePath);

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
        volume,
        archive,
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
        if (verified.tempPath) await volume.discard(verified.tempPath);
      } else if (target !== null) {
        let outcome: CommitOutcome;
        try {
          // The entry is verified but not yet published. Honor a cancellation
          // that arrived since its last streamed chunk so no file lands after
          // the abort instant — relevant under concurrency, where a sibling
          // entry may still be streaming.
          throwIfAborted(signal);
          if (entry.type === "dir") {
            outcome = await commitDir(volume, dest as string, segments);
          } else if (entry.type === "symlink") {
            outcome = await commitSymlink(
              volume,
              dest as string,
              segments.slice(0, -1),
              target,
              verified.linkTarget ?? "",
              writeOptions,
            );
          } else {
            outcome = await commitFile(
              volume,
              dest as string,
              segments.slice(0, -1),
              entry,
              verified.tempPath as string,
              target,
              writeOptions,
              signal,
            );
          }
        } catch (err) {
          if (verified.tempPath) await volume.discard(verified.tempPath);
          // A stall, and an abort (control flow, not a write fault), propagate
          // classified rather than mislabeled read.write-failed (exit 5); a
          // stall first, since a stalled publication may still land.
          if (err instanceof StallError) throw err;
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
    let manifestMismatched = 0;
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
      if (manifestMismatches.has(r.archivePath)) {
        manifestMismatched++;
        findings.push(
          finding(
            "extract.manifest-mismatch",
            r.archivePath,
            "size or CRC-32 in the archive does not match the manifest",
            { severity: "error" },
          ),
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
      (!spec.checkMetadata ||
        (missing.length === 0 &&
          extra.length === 0 &&
          shaMismatched === 0 &&
          manifestMismatched === 0));

    // Enumerate the failures before the aggregate: one warn/error line per
    // finding (CRC failure, SHA or size/CRC manifest mismatch, unsafe path,
    // missing/extra entry), so a corrupt or tampered archive logs *which*
    // entries failed, not just a count.
    // The per-success "entry.verified" lines stay at debug.
    reportFindings(deps.logger, "extract", findings);

    deps.logger.emit({
      stage: "extract",
      level: "info",
      event: "extract.done",
      total: entries.length,
      crcFailed,
      shaMismatched,
      manifestMismatched,
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
      summary: { total: entries.length, written, skipped, crcFailed, shaMismatched, manifestMismatched },
      entries,
      missing,
      extra,
      findings,
    };
  } finally {
    await archive.release();
  }
}

/** Restore a symlink. A link whose target resolves outside `dest`, or one whose
 *  parent chain crosses a symlink, is `unsafe` and never created — restoring it
 *  would leave an escape hatch a later entry (or the user) could write through.
 *  `exists` means an existing target was preserved. */
async function commitSymlink(
  volume: Volume,
  dest: string,
  parentSegments: string[],
  target: string,
  linkTarget: string,
  options: WriteOptions,
): Promise<CommitOutcome> {
  const resolved = path.resolve(path.dirname(target), linkTarget);
  if (escapesDest(dest, resolved)) return "unsafe";
  if (!(await ensureRealDirs(volume, dest, parentSegments))) return "unsafe";
  if (options.overwrite) await volume.remove(target);
  try {
    await volume.symlink(linkTarget, target);
  } catch (err) {
    if (!options.overwrite && (err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    throw err;
  }
  return "written"; // link times are not restored: no portable lutimes guarantee
}

/** A short, collision-resistant suffix for a per-entry temp file. */
function randomTag(): string {
  return nanoid(10);
}
