/**
 * The write edge. It consumes a writable plan and streams each entry into the
 * archive sequentially — the archive is one ordered byte stream. Each source
 * file flows through deflate (or a store pass-through) in `chunkSize` pieces, so
 * an arbitrarily large file is archived in bounded memory; its CRC-32 and
 * SHA-256 are computed incrementally as it streams. The manifest file is built
 * from the streamed results and injected as the final entry. The writer's
 * instructions are part of the plan (see `instructions.ts`), so `write(plan)`
 * needs no second argument.
 *
 * `writable` is the gate: a non-writable plan throws `write.not-writable`, with no
 * override for the error tier. The output is written to a temp file in its own
 * directory and atomically renamed into place by the writer.
 */

import { createHash, type Hash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { fsFailure, isStall, throwIfAborted, toAbortError, withUnknownEffect, ZipKitError } from "../errors.ts";
import { fromInstructions } from "../internal/instructions.ts";
import type { Volume } from "../internal/volume.ts";
import type { WriteEntry } from "../internal/types.ts";
import type { Logger } from "../log/logger.ts";
import type { PlanData, ProgressCounts, WriteData } from "../types.ts";
import { contentBytes } from "../plan/summary.ts";
import { Meter } from "../progress.ts";

import { buildManifest, manifestText } from "./manifest.ts";
import type { ManifestEntryInput } from "./manifest.ts";
import { EntryCompressor, ZipWriter } from "./zipWriter.ts";
import type { StreamResult, WriteEntryInput } from "./zipWriter.ts";

export interface WriteDeps {
  logger: Logger;
  chunkSize: number;
  signal?: AbortSignal;
  /** The run's bounded file access, built with the same signal. */
  volume: Volume;
  /** The caller's `onProgress`, for how far the write has got. */
  onProgress?: ((counts: ProgressCounts) => void) | undefined;
}

/** What each streamed entry contributed, gathered for the manifest record. */
interface StreamedEntry {
  source: WriteEntry;
  crc32: number;
  compressedSize: number;
  sha256?: string;
}

function toWriteEntryInput(source: WriteEntry): WriteEntryInput {
  return {
    name: source.archivePath,
    type: source.type,
    method: source.method,
    uncompressedSize: source.size,
    mtimeNs: source.mtimeNs,
    atimeNs: source.atimeNs,
    birthtimeNs: source.birthtimeNs,
    mode: source.mode,
  };
}

/** Whether an open source file no longer matches what the scan recorded. Only
 *  size and modification time count: ctime moves on a Finder tag or a
 *  permission change, which leaves the content as scanned. */
function changedSinceScan(source: WriteEntry, stats: BigIntStats): boolean {
  return Number(stats.size) !== source.size || stats.mtimeNs !== source.mtimeNs;
}

function sourceChanged(source: WriteEntry): ZipKitError {
  return new ZipKitError(
    "write.source-changed",
    `source changed while it was being archived: ${source.archivePath}`,
    { subject: source.archivePath },
  );
}

/**
 * Stream one source file through its compressor into the writer, computing the
 * SHA-256 over the raw bytes when requested. Directories carry no data and are
 * handled by the caller via `addDir`.
 *
 * The entry's header and the manifest carry the scanned size and time, so the
 * file must still be exactly what the scan saw: it is checked when opened,
 * while reading (no byte past the scanned size), and once read. Any change
 * fails the whole write, and the writer's abort removes its temp file.
 */
async function streamFile(
  writer: ZipWriter,
  source: WriteEntry,
  chunkSize: number,
  level: number,
  hasher: Hash | null,
  deps: WriteDeps,
  meter: Meter,
): Promise<StreamResult> {
  const input = toWriteEntryInput(source);
  return writer.streamEntry(input, async (sink) => {
    const compressor = new EntryCompressor(source.method, sink, chunkSize, level);
    try {
      const file = await deps.volume.open(source.absolutePath, "r");
      try {
        if (changedSinceScan(source, await file.stat())) throw sourceChanged(source);
        let position = 0;
        for (;;) {
          throwIfAborted(deps.signal);
          const buf = Buffer.allocUnsafe(chunkSize);
          const bytesRead = await file.read(buf, 0, chunkSize, position);
          if (bytesRead === 0) break;
          position += bytesRead;
          if (position > source.size) throw sourceChanged(source);
          const chunk = bytesRead === chunkSize ? buf : buf.subarray(0, bytesRead);
          if (hasher) hasher.update(chunk);
          await compressor.update(chunk);
          meter.bytes(bytesRead);
        }
        if (position !== source.size || changedSinceScan(source, await file.stat())) {
          throw sourceChanged(source);
        }
      } finally {
        await file.release();
      }
    } catch (err) {
      await compressor.dispose();
      // A cancel, a stall, or a destination fault surfacing through the
      // compressor is already classified; only a raw source error is mapped.
      throw fsFailure(err, source.absolutePath);
    }
    return compressor.finish();
  });
}

/** Stream an in-memory buffer (a symlink target or the manifest) as one entry. */
async function streamBuffer(
  writer: ZipWriter,
  input: WriteEntryInput,
  raw: Buffer,
  chunkSize: number,
  level: number,
): Promise<StreamResult> {
  return writer.streamEntry(input, async (sink) => {
    const compressor = new EntryCompressor(input.method, sink, chunkSize, level);
    try {
      if (raw.length > 0) await compressor.update(raw);
    } catch (err) {
      await compressor.dispose();
      throw err;
    }
    return compressor.finish();
  });
}

/** Stream text produced in pieces as one entry, gathered into chunk-sized
 *  writes so many small pieces cost no more than one large one. */
async function streamPieces(
  writer: ZipWriter,
  input: WriteEntryInput,
  pieces: Iterable<string>,
  chunkSize: number,
  level: number,
): Promise<StreamResult> {
  return writer.streamEntry(input, async (sink) => {
    const compressor = new EntryCompressor(input.method, sink, chunkSize, level);
    try {
      let gathered: string[] = [];
      let length = 0;
      for (const piece of pieces) {
        gathered.push(piece);
        length += piece.length;
        if (length < chunkSize) continue;
        await compressor.update(Buffer.from(gathered.join(""), "utf8"));
        gathered = [];
        length = 0;
      }
      if (length > 0) await compressor.update(Buffer.from(gathered.join(""), "utf8"));
    } catch (err) {
      await compressor.dispose();
      throw err;
    }
    return compressor.finish();
  });
}

export async function writeArchive(plan: PlanData, deps: WriteDeps): Promise<WriteData> {
  const internals = plan !== null && typeof plan === "object" ? fromInstructions(plan.instructions) : undefined;
  if (!internals) throw new ZipKitError("plan.invalid", "not a plan returned by plan(): its instructions are missing or malformed");
  if (!plan.writable) {
    throw new ZipKitError(
      "write.not-writable",
      "the plan is not writable: resolve blocking findings or authorize overwrite",
    );
  }

  // `timeZone` is the zone the plan resolved and checked the DOS range in; it is
  // recorded in the manifest so the local field is interpretable. The UTC extras
  // and manifest times need no zone.
  const { policy, writeEntries, overwrite, timeZone, comment } = internals;
  const level = policy.compression.level;
  const signal = deps.signal;
  throwIfAborted(signal);

  deps.logger.emit({ stage: "write", level: "info", event: "write.start", entries: writeEntries.length });

  const hash = policy.manifest !== false && policy.manifest.hash;
  const createdNs = BigInt(Date.now()) * 1_000_000n;

  // The plan already computed the Zip64 verdict over the full content (entries
  // plus the manifest the writer injects); reuse it as the up-front decision
  // rather than rebuilding and re-estimating here. `finalize()` recomputes the
  // truth from the real offsets and returns it as `zip64`; this up-front value
  // only forces Zip64 on when the estimate already requires it.
  const zip64Needed = plan.summary.zip64;

  const meter = new Meter(
    "write",
    { entries: writeEntries.length, bytes: writeEntries.reduce((sum, entry) => sum + contentBytes(entry), 0) },
    deps.onProgress,
  );
  const writer = new ZipWriter(
    plan.output,
    { timeZone, chunkSize: deps.chunkSize, overwrite },
    deps.volume,
  );

  let zip64 = false;
  let bytes = 0;
  try {
    await writer.open();

    const streamed: StreamedEntry[] = [];
    for (const source of writeEntries) {
      throwIfAborted(signal);
      if (source.type === "dir") {
        await writer.addDir(toWriteEntryInput(source));
        streamed.push({ source, crc32: 0, compressedSize: 0 });
        deps.logger.emit({ stage: "write", level: "debug", event: "entry.written", path: source.archivePath });
        meter.entry();
        continue;
      }

      if (source.type === "symlink") {
        const raw = Buffer.from(source.linkTarget ?? "", "utf8");
        const result = await streamBuffer(
          writer,
          toWriteEntryInput(source),
          raw,
          deps.chunkSize,
          level,
        );
        const entry: StreamedEntry = {
          source,
          crc32: result.crc32,
          compressedSize: result.compressedSize,
        };
        if (hash) entry.sha256 = createHash("sha256").update(raw).digest("hex");
        streamed.push(entry);
        deps.logger.emit({ stage: "write", level: "debug", event: "entry.written", path: source.archivePath });
        meter.bytes(raw.length);
        meter.entry();
        continue;
      }

      const hasher = hash ? createHash("sha256") : null;
      const result = await streamFile(writer, source, deps.chunkSize, level, hasher, deps, meter);
      const entry: StreamedEntry = {
        source,
        crc32: result.crc32,
        compressedSize: result.compressedSize,
      };
      if (hasher) entry.sha256 = hasher.digest("hex");
      streamed.push(entry);
      deps.logger.emit({ stage: "write", level: "debug", event: "entry.written", path: source.archivePath });
      meter.entry();
    }

    // Phase edge between streaming and finalize: a cancellation that arrived
    // during the last entry has no later boundary to trip, and past finalize the
    // output is renamed into place. Honor it here so a cancelled write leaves
    // nothing behind — the catch's writer.abort() discards the temp file.
    throwIfAborted(signal);

    // The structured record is always built and returned — it is the run's full
    // state. Embedding it as `zipkit.json` is the only part gated by policy.
    const manifestEntries: ManifestEntryInput[] = streamed.map((s) => {
      const input: ManifestEntryInput = {
        writeEntry: s.source,
        crc32: s.crc32,
        compressedSize: s.compressedSize,
      };
      if (s.sha256 !== undefined) input.sha256 = s.sha256;
      return input;
    });
    const manifest = buildManifest(
      plan,
      policy,
      manifestEntries,
      createdNs,
      timeZone,
      comment,
    );

    if (policy.manifest !== false) {
      // A ZIP is a container, so the manifest rides inside it rather than as a
      // loose file that could drift away from the archive. Its text is produced
      // in pieces twice, once to count its bytes for the entry's header and once
      // into the archive, so the whole text is never held (volume-handling
      // conventions, Data size): a folder of any size gets its manifest.
      let length = 0;
      for (const piece of manifestText(manifest)) length += Buffer.byteLength(piece, "utf8");
      await streamPieces(
        writer,
        {
          name: policy.manifest.name,
          type: "file",
          method: "deflate",
          uncompressedSize: length,
          mtimeNs: createdNs,
          atimeNs: createdNs,
          birthtimeNs: createdNs,
          mode: 0,
        },
        manifestText(manifest),
        deps.chunkSize,
        level,
      );
    }

    const final = await writer.finalize(zip64Needed, comment, signal);
    zip64 = final.zip64;
    bytes = final.bytes;

    deps.logger.emit({ stage: "write", level: "info", event: "write.done", bytes, zip64 });
    meter.finish();

    return {
      mode: "write",
      output: plan.output,
      // The exact post-write outcome from finalize.
      bytes,
      zip64,
      // The plan summary, carried verbatim — the same object the embedded manifest
      // holds. Its `zip64` is the pre-write upper-bound estimate; the top-level
      // `zip64` above is the exact outcome, so a caller reads that for the truth.
      summary: plan.summary,
      findings: plan.findings,
      manifest,
    };
  } catch (err) {
    // A temporary file that could not be removed is left behind, so the
    // failure's effect is not nothing.
    const cleaned = await writer.abort();
    const left = (e: unknown): unknown => (cleaned ? e : withUnknownEffect(e));
    // A publication stall or flush failure keeps its truthful output status,
    // even when cancellation arrived during that publication.
    if (isStall(err) || (err instanceof ZipKitError && err.code === "write.durability")) throw left(err);
    if (signal?.aborted) throw left(toAbortError(signal.reason));
    if (err instanceof ZipKitError && err.code.startsWith("write.")) throw left(err);
    throw left(new ZipKitError("write.failed", `failed to write ${plan.output}`, { cause: err, subject: plan.output }));
  }
}
