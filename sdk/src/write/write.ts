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
 * The instructions are the gate: a plan whose reviewed entries, findings or
 * summary disagree with them is `plan.invalid`, and one they do not let
 * write is `write.not-writable`, with no override for the error tier. The
 * output is written to a temp file in its own directory and published by the
 * writer; an output that appeared since the plan, when replacing it was not
 * authorized, returns the plan blocked by `output.exists`, as `create` returns
 * a plan that blocks.
 */

import { createHash, type Hash } from "node:crypto";
import path from "node:path";
import type { BigIntStats } from "node:fs";
import { createPathClaims, pathResources } from "../claims.ts";
import { classify, fsFailure, isStall, throwIfAborted, toAbortError, withUnknownEffect, ZipKitError } from "../errors.ts";
import type { PlanInternals } from "../internal/instructions.ts";
import { fromPlan } from "../internal/instructions.ts";
import type { Volume } from "../internal/volume.ts";
import type { WriteEntry } from "../internal/types.ts";
import type { Logger } from "../log/logger.ts";
import { finding } from "../registry.ts";
import type { Finding, PlanData, Program, ProgressCounts, WriteData } from "../types.ts";
import { outputExists } from "../plan/plan.ts";
import { contentBytes } from "../plan/summary.ts";
import { Meter } from "../progress.ts";

import { buildManifest, manifestText } from "./manifest.ts";
import type { ManifestEntryInput } from "./manifest.ts";
import { EntryCompressor } from "./deflate.ts";
import { ZipWriter } from "./zipWriter.ts";
import type { StreamResult, WriteEntryInput } from "./zipWriter.ts";

// Checked-rename publication cannot exclude another SDK writer at the OS
// boundary. Share output admission across instances until native work settles.
const outputClaims = createPathClaims();

export interface WriteDeps {
  logger: Logger;
  chunkSize: number;
  signal?: AbortSignal;
  /** The run's bounded file access, built with the same signal. */
  volume: Volume;
  /** The caller's `onProgress`, for how far the write has got. */
  onProgress?: ((counts: ProgressCounts) => void) | undefined;
  /** The calling app, recorded in the manifest when it named itself. */
  app?: Program | undefined;
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
    `source changed while it was being archived: ${source.absolutePath}`,
    { subject: source.absolutePath },
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

/** The writer's instructions from a plan, refused as `plan.invalid` when they
 *  are malformed or the plan's visible fields say otherwise. */
function checkedInstructions(plan: PlanData): PlanInternals {
  const given = plan !== null && typeof plan === "object" ? plan : undefined;
  const internals = fromPlan(given);
  const subject = typeof given?.output === "string" ? { subject: given.output } : {};
  if (!internals) throw new ZipKitError("plan.invalid", "not a plan returned by plan(): its instructions are missing or malformed", subject);
  return internals;
}

/** The plan blocked by its output's name being taken since it was made. */
function blocked(plan: PlanData, reason: Finding): PlanData {
  return {
    ...plan,
    writable: false,
    summary: { ...plan.summary, errors: plan.summary.errors + 1 },
    findings: [...plan.findings, reason],
    instructions: { ...plan.instructions, writable: false },
  };
}

export async function writeArchive(plan: PlanData, deps: WriteDeps): Promise<WriteData | PlanData> {
  const internals = checkedInstructions(plan);
  const { output, writable } = internals;
  if (!writable) {
    throw new ZipKitError(
      "write.not-writable",
      "the plan is not writable: resolve blocking findings or authorize overwrite",
      { subject: output },
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
  const zip64Needed = internals.zip64;

  const meter = new Meter(
    "write",
    { entries: writeEntries.length, bytes: writeEntries.reduce((sum, entry) => sum + contentBytes(entry), 0) },
    deps.onProgress,
  );
  const writer = new ZipWriter(
    output,
    { timeZone, chunkSize: deps.chunkSize, overwrite },
    deps.volume,
  );

  const claim = outputClaims.claim((await pathResources([output], deps.volume)).map((resource) => ({ ...resource, mode: "change" })));
  // Refused like a plan that blocks, whether or not overwriting was allowed:
  // neither write may silently replace the other.
  if (!claim) return blocked(plan, finding("output.busy", output, "another write to this output has not finished"));

  let zip64 = false;
  let bytes = 0;
  try {
    // A missing output folder, with its parents, is made before anything is
    // written into it (sdk-conventions, Durable output).
    try { await deps.volume.mkdir(path.dirname(output)); }
    catch (error) { throw fsFailure(error, path.dirname(output)); }
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
        let target: string;
        try {
          const stats = await deps.volume.lstat(source.absolutePath);
          if (!stats.isSymbolicLink() || changedSinceScan(source, stats)) throw sourceChanged(source);
          target = await deps.volume.readlink(source.absolutePath);
          if (target !== source.linkTarget) throw sourceChanged(source);
        } catch (error) { throw fsFailure(error, source.absolutePath); }
        const raw = Buffer.from(target, "utf8");
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
    const manifest = buildManifest(plan, policy, manifestEntries, { createdNs, timeZone, comment, app: deps.app });

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
    if (final.publication === "exists") {
      await writer.abort();
      return blocked(plan, outputExists(plan.output));
    }
    zip64 = final.zip64;
    bytes = final.bytes;

    deps.logger.emit({ stage: "write", level: "info", event: "write.done", bytes, zip64 });
    meter.finish();

    return {
      mode: "write",
      output,
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
    // A publication stall keeps its truthful output status, even when
    // cancellation arrived during that publication.
    if (isStall(err)) throw left(err);
    if (signal?.aborted) throw left(toAbortError(signal.reason));
    // The sources and the writer classify their own file failures; anything
    // else is the SDK's own fault.
    throw left(classify(err, output));
  } finally {
    claim.release(deps.volume.whenSettled());
  }
}
