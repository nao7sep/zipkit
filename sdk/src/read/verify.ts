/**
 * Verification: one read of an archive that checks it is what it claims to be.
 * Every entry is decompressed and its CRC-32 checked against a null sink, so it
 * works on any ZIP; each entry's local header is compared with its central
 * record, as tools that walk local headers would read it; and under `manifest`
 * the archive is reconciled with its embedded manifest (every recorded entry
 * present, nothing extra, each type, size, CRC-32 and recorded SHA-256 equal).
 * An entry whose data cannot be read (an unsupported method, a broken deflate
 * stream, a size that disagrees) is reported on its own; only a failure of the
 * archive as a whole, or of the disk it is on, ends the run.
 *
 * Reads are positioned against one open handle, never a whole-archive buffer,
 * and entries run concurrently within the pool, so memory stays bounded. Every
 * file-system call goes through the run's bounded {@link Volume}.
 */

import { createHash } from "node:crypto";
import { fsFailure, isStall, throwIfAborted, ZipKitError } from "../errors.ts";
import type { Volume, VolumeFile } from "../internal/volume.ts";
import { reportFindings } from "../log/findings.ts";
import type { Logger } from "../log/logger.ts";
import { Meter } from "../progress.ts";
import { finding } from "../registry.ts";
import type { Finding, ProgressCounts, VerifiedEntry, VerifyData } from "../types.ts";
import { MANIFEST_FORMAT_VERSION } from "../write/manifest.ts";
import { createManifestReader, type ManifestReading } from "./manifestReader.ts";
import { localHeaderMismatch, parseZip, readEntryData, type ParsedZip, type ReadEntry } from "./zipReader.ts";

export interface VerifyDeps {
  limit: <T>(fn: () => Promise<T>) => Promise<T>;
  logger: Logger;
  chunkSize: number;
  signal?: AbortSignal;
  /** The run's bounded file access, built with the same signal. */
  volume: Volume;
  /** The caller's `onProgress`, for how far the read has got. */
  onProgress?: ((counts: ProgressCounts) => void) | undefined;
}

/** What a verification checks: the archive, and whether and under which name
 *  to hold it to its embedded manifest. */
export interface VerifyRequest {
  archive: string;
  manifest: boolean;
  manifestName: string;
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
export function isManifestRecord(value: unknown): value is ManifestRecord {
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

/** Only the fields verification and source comparison read, so a large
 *  folder's records hold nothing else. */
function compactRecord(record: ManifestRecord): ManifestRecord {
  const kept: ManifestRecord = {
    archivePath: record.archivePath,
    sourcePath: record.sourcePath,
    type: record.type,
    size: record.size,
    crc32: record.crc32,
    mtime: { ns: record.mtime.ns },
  };
  if (record.sha256 !== undefined) kept.sha256 = record.sha256;
  return kept;
}

/** Find and read the embedded manifest `name` among an open archive's entries,
 *  one record at a time. Absent is `manifest.missing`; unparseable, without a
 *  `formatVersion` or `entries` list, or holding a malformed or repeated record
 *  is `manifest.invalid`; one a newer ZipKit wrote is `manifest.newer`, never
 *  read as this build's format. */
async function loadManifest(
  archive: VolumeFile,
  entries: ReadEntry[],
  name: string,
  chunkSize: number,
): Promise<{ entry: ReadEntry; records: ManifestRecord[] }> {
  const inside = entries.find((e) => e.archivePath === name);
  if (!inside) throw new ZipKitError("manifest.missing", `no manifest '${name}' is embedded in the archive`, { subject: name });
  const paths = new Set<string>();
  const reader = createManifestReader((record) => {
    if (!isManifestRecord(record)) return { refuse: `manifest ${name} holds a malformed entry record` };
    if (paths.has(record.archivePath)) return { refuse: `manifest ${name} records '${record.archivePath}' twice` };
    paths.add(record.archivePath);
    return { keep: compactRecord(record) };
  });
  let reading: ManifestReading;
  try {
    await readEntryData(archive, inside, (chunk) => reader.push(chunk), chunkSize);
    reading = await reader.finish();
  } catch (err) {
    // A stall, a cancel or a damaged archive keeps its own code; only the
    // document itself failing to parse is an invalid manifest.
    if (err instanceof ZipKitError) throw err;
    throw new ZipKitError("manifest.invalid", `manifest ${name} is not valid JSON`, { cause: err, subject: name });
  }
  const formatVersion = reading.formatVersion;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new ZipKitError("manifest.invalid", `manifest ${name} has no valid formatVersion`, { subject: name });
  }
  if (formatVersion > MANIFEST_FORMAT_VERSION) {
    throw new ZipKitError(
      "manifest.newer",
      `manifest ${name} has format version ${formatVersion}, newer than this build's ${MANIFEST_FORMAT_VERSION}`,
      { subject: name },
    );
  }
  if (!reading.hasEntries) throw new ZipKitError("manifest.invalid", `manifest ${name} has no entries list`, { subject: name });
  if (reading.problem !== null) throw new ZipKitError("manifest.invalid", reading.problem, { subject: name });
  return { entry: inside, records: reading.records as ManifestRecord[] };
}

/** Open `archivePath`, parse its central directory and hand both to `use`,
 *  releasing the handle after. A failure to open or stat it is the disk's,
 *  reported by cause with the archive as its subject. */
export async function withArchive<T>(volume: Volume, archivePath: string, use: (archive: VolumeFile, parsed: ParsedZip) => Promise<T>): Promise<T> {
  let archive: VolumeFile;
  try {
    archive = await volume.open(archivePath, "r");
  } catch (err) {
    throw fsFailure(err, archivePath);
  }
  try {
    let fileSize: number;
    try {
      fileSize = Number((await archive.stat()).size);
    } catch (err) {
      throw fsFailure(err, archivePath);
    }
    return await use(archive, await parseZip(archive, fileSize));
  } finally {
    await archive.release();
  }
}

/** The entry records of the manifest embedded in `archivePath`. */
export async function readManifestRecords(volume: Volume, archivePath: string, name: string, chunkSize: number): Promise<ManifestRecord[]> {
  return withArchive(volume, archivePath, async (archive, parsed) => (await loadManifest(archive, parsed.entries, name, chunkSize)).records);
}

/** Whether a manifest record's type, size or CRC-32 disagrees with the archive's central directory. */
function recordMismatches(record: ManifestRecord, entry: ReadEntry): boolean {
  // Format 1 records the source directory's stat size, while a ZIP directory
  // stores no bytes, so a directory's size is not compared.
  return record.type !== entry.type ||
    (entry.type !== "dir" && record.size !== entry.uncompSize) || record.crc32 !== entry.crc32 >>> 0;
}

/** The read failures that belong to one entry's data rather than the archive. */
const ENTRY_DATA_FAILURES = new Set(["archive.unsupported-method", "archive.corrupt-data", "archive.size-mismatch"]);

/** One entry read through: its CRC-32, its SHA-256 against the manifest's when
 *  there is one to compare, or why its data could not be read. */
async function readEntry(
  archive: VolumeFile,
  entry: ReadEntry,
  chunkSize: number,
  storedSha: string | null | undefined,
  signal: AbortSignal | undefined,
  meter: Meter,
): Promise<{ crc32: VerifiedEntry["crc32"]; sha256?: VerifiedEntry["sha256"]; unreadable?: string }> {
  const checkSha = storedSha !== undefined;
  if (entry.type === "dir") return checkSha ? { crc32: "ok", sha256: storedSha ? "ok" : "absent" } : { crc32: "ok" };
  const hasher = checkSha && storedSha !== null ? createHash("sha256") : null;
  let crc32: number;
  try {
    ({ crc32 } = await readEntryData(archive, entry, async (chunk) => {
      throwIfAborted(signal);
      hasher?.update(chunk);
      meter.bytes(chunk.length);
    }, chunkSize));
  } catch (err) {
    if (err instanceof ZipKitError && ENTRY_DATA_FAILURES.has(err.code)) return { crc32: "unreadable", unreadable: err.message };
    throw err;
  }
  const crcOk = crc32 === (entry.crc32 >>> 0);
  if (!checkSha) return { crc32: crcOk ? "ok" : "fail" };
  return {
    crc32: crcOk ? "ok" : "fail",
    sha256: storedSha === null ? "absent" : hasher!.digest("hex") === storedSha ? "ok" : "mismatch",
  };
}

export async function verifyArchive(request: VerifyRequest, deps: VerifyDeps): Promise<VerifyData> {
  const signal = deps.signal;
  throwIfAborted(signal);
  return withArchive(deps.volume, request.archive, async (archive, parsed) => {
    deps.logger.emit({ stage: "verify", level: "info", event: "verify.start", entries: parsed.entries.length });
    const meter = new Meter(
      "verify",
      { entries: parsed.entries.length, bytes: parsed.entries.reduce((sum, entry) => sum + entry.uncompSize, 0) },
      deps.onProgress,
    );

    let manifest: VerifyData["manifest"] = null;
    let manifestEntryPath: string | undefined;
    const manifestMap = new Map<string, ManifestRecord>();
    if (request.manifest) {
      const loaded = await loadManifest(archive, parsed.entries, request.manifestName, deps.chunkSize);
      manifestEntryPath = loaded.entry.archivePath;
      manifest = { name: request.manifestName };
      for (const m of loaded.records) manifestMap.set(m.archivePath, m);
    }

    const manifestMismatches = new Set<string>();
    const localMismatches = new Map<string, string>();
    const unreadable = new Map<string, string>();

    // `allSettled`, not `all`: every task runs to completion so none keeps
    // reading the handle the caller is about to release. Each task's calls are
    // bounded, and once one stalls the volume refuses the rest, so this wait is
    // bounded too. A stall is reported ahead of the refusals it caused.
    const settled = await Promise.allSettled(
      parsed.entries.map((entry) =>
        deps.limit(async (): Promise<VerifiedEntry> => {
          throwIfAborted(signal);
          const isManifestEntry = entry.archivePath === manifestEntryPath;
          const record = request.manifest && !isManifestEntry ? manifestMap.get(entry.archivePath) : undefined;
          // The archive's own header is all the CRC check compares against, so
          // a replaced entry passes it; comparing the central directory's type,
          // size and CRC-32 with the manifest catches it even without a SHA-256.
          if (record && recordMismatches(record, entry)) manifestMismatches.add(entry.archivePath);
          const local = await localHeaderMismatch(archive, entry);
          if (local !== null) localMismatches.set(entry.archivePath, local);
          const storedSha = request.manifest && !isManifestEntry ? (record?.sha256 ?? null) : undefined;
          const read = await readEntry(archive, entry, deps.chunkSize, storedSha, signal, meter);
          if (read.unreadable !== undefined) unreadable.set(entry.archivePath, read.unreadable);
          meter.entry();
          deps.logger.emit({ stage: "verify", level: "debug", event: "entry.verified", path: entry.archivePath });
          const result: VerifiedEntry = { archivePath: entry.archivePath, type: entry.type, crc32: read.crc32 };
          if (read.sha256 !== undefined) result.sha256 = read.sha256;
          return result;
        }),
      ),
    );
    const failures = settled.flatMap((s) => (s.status === "rejected" ? [s.reason as unknown] : []));
    const failure = failures.find((f) => isStall(f)) ?? failures[0];
    if (failure !== undefined) throw failure;
    const entries = settled.map((s) => (s as PromiseFulfilledResult<VerifiedEntry>).value);

    const findings: Finding[] = [];
    const seen = new Set<string>();
    let crc32Failed = 0;
    let sha256Mismatched = 0;
    for (const r of entries) {
      if (r.archivePath !== manifestEntryPath) seen.add(r.archivePath);
      if (r.crc32 === "fail") {
        crc32Failed++;
        findings.push(finding("verify.crc32-mismatch", r.archivePath, "CRC-32 mismatch: entry is corrupt", { severity: "error" }));
      }
      const why = unreadable.get(r.archivePath);
      if (why !== undefined) findings.push(finding("verify.unreadable", r.archivePath, `entry data cannot be read: ${why}`, { severity: "error" }));
      if (r.sha256 === "mismatch") {
        sha256Mismatched++;
        findings.push(finding("verify.sha256-mismatch", r.archivePath, "content hash does not match the manifest", { severity: "error" }));
      }
      if (manifestMismatches.has(r.archivePath)) {
        findings.push(finding("verify.manifest-mismatch", r.archivePath, "type, size or CRC-32 in the archive does not match the manifest", { severity: "error" }));
      }
      const local = localMismatches.get(r.archivePath);
      if (local !== undefined) {
        findings.push(finding("verify.local-mismatch", r.archivePath, `local header disagrees with the central directory: ${local}`, { severity: "error" }));
      }
    }

    const missing: string[] = [];
    const extra: string[] = [];
    if (request.manifest) {
      for (const key of manifestMap.keys()) if (!seen.has(key)) missing.push(key);
      for (const key of seen) if (!manifestMap.has(key)) extra.push(key);
      for (const m of missing) findings.push(finding("verify.missing", m, "entry is in the manifest but absent from the archive", { severity: "error" }));
      for (const e of extra) findings.push(finding("verify.extra", e, "entry is in the archive but absent from the manifest", { severity: "warning" }));
    }

    const summary: VerifyData["summary"] = {
      total: entries.length,
      crc32Failed,
      unreadable: unreadable.size,
      localMismatched: localMismatches.size,
      sha256Mismatched,
      manifestMismatched: manifestMismatches.size,
    };
    const ok =
      summary.crc32Failed === 0 && summary.unreadable === 0 && summary.localMismatched === 0 &&
      (!request.manifest || (missing.length === 0 && extra.length === 0 && summary.sha256Mismatched === 0 && summary.manifestMismatched === 0));

    // Each failure as its own line before the aggregate, so a corrupt or
    // tampered archive logs which entries failed, not just a count.
    reportFindings(deps.logger, "verify", findings);
    deps.logger.emit({ stage: "verify", level: "info", event: "verify.done", ...summary, ok });
    meter.finish();
    return { archive: request.archive, ok, manifest, summary, entries, missing, extra, findings };
  });
}
