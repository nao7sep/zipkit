/**
 * The extract/validate edge. One pass over the archive drives both: every entry
 * is decompressed and CRC-checked (so a dry run is a pure integrity test that
 * works on any ZIP); under `checkMetadata` each entry is also reconciled against
 * the manifest and its recorded SHA-256; and unless `dryRun` is set, verified
 * entries are written to disk with their times restored — a folder's last, once
 * every entry is in place, since writing into a folder moves its time.
 *
 * Reads are positioned against an open handle, never a whole-archive buffer, and an
 * entry's content streams through inflate to its own output file — so memory
 * stays bounded and entries run CONCURRENTLY (bounded by the pool), each writing
 * an independent file. CRC governs writing: an entry streams to a temp file
 * beside its target, and only a CRC-clean entry that passes the path-safety,
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
import { MANIFEST_FORMAT_VERSION } from "../write/metadata.js";
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
  /** Read size when comparing a verified entry with the file it would replace. */
  chunkSize: number;
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
 *  outside `dest`; the entry is then written nowhere. `unchanged` means an
 *  overwrite found the target already holding the entry's content, and left it. */
type CommitOutcome = "written" | "exists" | "unchanged" | "unsafe";

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

/** One `entries` record of an embedded manifest: the fields verification and
 *  source comparison consume, checked when the manifest is loaded. */
export interface ManifestRecord {
  archivePath: string;
  sourcePath: string;
  type: "file" | "dir" | "symlink";
  size: number;
  crc32: number;
  /** Absent when the writer's hash policy omitted it. */
  sha256?: string;
  mtime: { ns: string };
}

/** Whether an untrusted `entries` item holds every field a {@link ManifestRecord} requires. */
function isManifestRecord(value: unknown): value is ManifestRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const mtime = r.mtime as Record<string, unknown> | null | undefined;
  return (
    typeof r.archivePath === "string" && r.archivePath !== "" &&
    typeof r.sourcePath === "string" &&
    (r.type === "file" || r.type === "dir" || r.type === "symlink") &&
    Number.isSafeInteger(r.size) && (r.size as number) >= 0 &&
    Number.isInteger(r.crc32) && (r.crc32 as number) >= 0 && (r.crc32 as number) <= 0xffffffff &&
    (r.sha256 === undefined || (typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256))) &&
    typeof mtime === "object" && mtime !== null && typeof mtime.ns === "string" && /^-?\d+$/.test(mtime.ns)
  );
}

/** Find and parse the embedded manifest `name` among an open archive's entries.
 *  Absent is `read.manifest-missing`; unparseable, or holding a malformed or
 *  duplicate record, is `read.manifest-invalid`; one a newer ZipKit wrote is
 *  `read.manifest-newer`, never read as this build's format. A manifest without
 *  `formatVersion` is unparseable. */
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
  let doc: { formatVersion?: unknown; entries?: unknown };
  try {
    doc = JSON.parse((await readEntryBuffer(archive, inside, MAX_MANIFEST_BYTES)).toString("utf8"));
  } catch (err) {
    if (err instanceof StallError || err instanceof AbortError) throw err;
    throw new ReadError("read.manifest-invalid", `manifest ${name} is not valid JSON`, {
      cause: err,
    });
  }
  const formatVersion = doc?.formatVersion;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new ReadError("read.manifest-invalid", `manifest ${name} has no valid formatVersion`);
  }
  if (formatVersion > MANIFEST_FORMAT_VERSION) {
    throw new ReadError(
      "read.manifest-newer",
      `manifest ${name} has format version ${formatVersion}, newer than this build's ${MANIFEST_FORMAT_VERSION}`,
    );
  }
  if (!Array.isArray(doc.entries)) {
    throw new ReadError("read.manifest-invalid", `manifest ${name} has no entries list`);
  }
  const paths = new Set<string>();
  for (const record of doc.entries as unknown[]) {
    if (!isManifestRecord(record)) {
      throw new ReadError("read.manifest-invalid", `manifest ${name} holds a malformed entry record`);
    }
    if (paths.has(record.archivePath)) {
      throw new ReadError("read.manifest-invalid", `manifest ${name} records '${record.archivePath}' twice`);
    }
    paths.add(record.archivePath);
  }
  return { entry: inside, records: doc.entries as ManifestRecord[] };
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

/** Whether a manifest record's size or CRC-32 disagrees with the archive's central directory. */
function recordMismatches(record: ManifestRecord, entry: ReadEntry): boolean {
  return record.size !== entry.uncompSize || record.crc32 !== entry.crc32 >>> 0;
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
  const out = stageTo ? await volume.createTemp(stageTo) : null;

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
  // A replaced file keeps its own permission mode; a new one takes the entry's.
  let replaced = false;
  if (options.overwrite) {
    if (await sameContent(volume, target, tempPath, entry.uncompSize, options.chunkSize)) {
      await volume.discard(tempPath);
      return "unchanged";
    }
    replaced = await volume.keepMode(target, tempPath);
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
  if (options.restore) await restoreEntryTimes(volume, target, entry, options.timeZone);
  if (!replaced) await restoreEntryMode(volume, target, entry);
  return "written";
}

/** Whether `target` is a regular file holding exactly the verified bytes in
 *  `tempPath`, `size` long. A target that cannot be read is treated as
 *  different, so the replace goes ahead and reports its own failure. */
async function sameContent(
  volume: Volume,
  target: string,
  tempPath: string,
  size: number,
  chunkSize: number,
): Promise<boolean> {
  let existing: VolumeFile;
  try {
    const st = await volume.lstat(target);
    if (!st.isFile() || Number(st.size) !== size) return false;
    existing = await volume.open(target, "r");
  } catch (err) {
    if (err instanceof ZipKitError) throw err;
    return false;
  }
  try {
    const staged = await volume.open(tempPath, "r");
    try {
      const a = Buffer.allocUnsafe(chunkSize);
      const b = Buffer.allocUnsafe(chunkSize);
      for (let position = 0; position < size; ) {
        const length = Math.min(chunkSize, size - position);
        const [readA, readB] = [await existing.read(a, 0, length, position), await staged.read(b, 0, length, position)];
        if (readA !== length || readB !== length || !a.subarray(0, length).equals(b.subarray(0, length))) return false;
        position += length;
      }
      return true;
    } finally {
      await staged.release();
    }
  } catch (err) {
    if (err instanceof ZipKitError) throw err;
    return false;
  } finally {
    await existing.release();
  }
}

/** Set a new file's permission bits from its entry's Unix attributes, when the
 *  entry carries a regular-file mode; a FAT-host entry carries none. Never the
 *  set-id or sticky bits, which an archive should not grant. Best-effort like
 *  the times: a volume that cannot hold the mode keeps the file as written. */
async function restoreEntryMode(volume: Volume, target: string, entry: ReadEntry): Promise<void> {
  const unixMode = (entry.externalAttr >>> 16) & 0xffff;
  if ((unixMode & 0xf000) !== 0x8000) return;
  try {
    await volume.chmod(target, unixMode & 0o777);
  } catch (err) {
    if (err instanceof ZipKitError) throw err;
  }
}

/** Set a written entry's stored modification and access times on `target`.
 *  Best-effort: a filesystem that rejects the times must not fail the write. A
 *  stall or a cancel is not such a rejection and still ends the run. */
async function restoreEntryTimes(volume: Volume, target: string, entry: ReadEntry, timeZone: string): Promise<void> {
  const t = restoreTimes(entry, timeZone);
  try {
    await volume.utimes(target, t.atimeNs, t.mtimeNs);
  } catch (err) {
    if (err instanceof ZipKitError) throw err;
    /* times are advisory; the content is what matters */
  }
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
    chunkSize: deps.chunkSize,
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
      for (const m of loaded.records) manifestMap.set(m.archivePath, m);
    }

    if (write && dest !== undefined) await volume.mkdir(dest, true);

    // Per-entry processing runs concurrently — each entry streams to its own
    // output file. `aborted` short-circuits the pool once an `onUnsafe: abort`
    // entry is found, so the run fails fast without spawning the rest.
    const abort: { entry: ReadEntry | null } = { entry: null };
    // Entries whose size or CRC-32 differs from their manifest record.
    const manifestMismatches = new Set<string>();
    // Folder entries written, whose times are restored once every entry is in
    // place: writing a file into a folder moves the folder's modified time.
    const writtenDirs: { entry: ReadEntry; target: string }[] = [];
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
    if (writeOptions.restore) {
      for (const { entry, target } of writtenDirs) {
        throwIfAborted(signal);
        await restoreEntryTimes(volume, target, entry, writeOptions.timeZone);
      }
    }

    /** A failure while writing an entry. A stall, and an abort (control flow,
     *  not a write fault), stay classified rather than mislabeled
     *  read.write-failed (exit 5); a stall first, since a stalled publication
     *  may still land. */
    function writeFailure(entry: ReadEntry, err: unknown): unknown {
      if (err instanceof StallError) return err;
      if (signal?.aborted) return toAbortError(signal.reason);
      return new ReadError("read.write-failed", `cannot write ${entry.archivePath}`, { cause: err });
    }

    async function processEntry(entry: ReadEntry): Promise<ExtractEntryResult> {
      const isManifestEntry = entry.archivePath === manifestEntryPath;
      const checkSha = spec.checkMetadata === true && entry.type !== "dir" && !isManifestEntry;
      const record = checkSha ? manifestMap.get(entry.archivePath) : undefined;
      const storedSha = record?.sha256 ?? null;
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

      // A file is staged beside its target, once its real parent chain exists,
      // so publication is a rename within one directory even when a parent is
      // a mount of another volume. A symlinked parent makes it unsafe.
      let tempPath: string | null = null;
      if (target !== null && entry.type === "file") {
        let parentSafe: boolean;
        try {
          parentSafe = await ensureRealDirs(volume, dest as string, segments.slice(0, -1));
        } catch (err) {
          throw writeFailure(entry, err);
        }
        if (parentSafe) {
          tempPath = stagingPath(path.dirname(target));
        } else {
          target = null;
          skip = "unsafe";
          if (onUnsafe === "abort") abort.entry ??= entry;
        }
      }
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
          throw writeFailure(entry, err);
        }
        if (outcome === "written") {
          didWrite = true;
          outputPath = target;
          if (entry.type === "dir") writtenDirs.push({ entry, target });
        } else if (outcome === "exists" || outcome === "unchanged") {
          skip = outcome;
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
 *  `exists` means an existing target was preserved. An overwrite creates the
 *  link under a sibling temp name and renames it over the target, so a refused
 *  link creation leaves the existing target intact. */
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
  if (options.overwrite) {
    try {
      const existing = await volume.lstat(target);
      if (existing.isSymbolicLink() && (await volume.readlink(target)) === linkTarget) return "unchanged";
    } catch (err) {
      if (err instanceof ZipKitError) throw err;
    }
    const staged = stagingPath(path.dirname(target));
    try {
      await volume.symlink(linkTarget, staged);
      await volume.publishRename(staged, target);
    } catch (err) {
      await volume.discard(staged);
      throw err;
    }
    return "written";
  }
  try {
    await volume.symlink(linkTarget, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    throw err;
  }
  return "written"; // link times are not restored: no portable lutimes guarantee
}

/** A unique per-entry temp path in `dir`. */
function stagingPath(dir: string): string {
  return path.join(dir, `.zk-${process.pid}-${nanoid(10)}.tmp`);
}
