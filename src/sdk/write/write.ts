/**
 * The write edge. It consumes a writable plan and streams each entry into the
 * archive sequentially — the archive is one ordered byte stream. Each source
 * file flows through deflate (or a store pass-through) in `chunkSize` pieces, so
 * an arbitrarily large file is archived in bounded memory; its CRC-32 and
 * SHA-256 are computed incrementally as it streams. The metadata file is built
 * from the streamed results and injected as the final entry. The writer
 * instructions ride on the plan (see `carrier.ts`), so `write(plan)` needs no
 * second argument.
 *
 * `writable` is the gate: a non-writable plan throws `WriteError`, with no
 * override for the error tier. The output is written to a temp file in its own
 * directory and atomically renamed into place by the writer.
 */

import { createHash, type Hash } from "node:crypto";
import { StallError, throwIfAborted, toAbortError, WriteError, ZipKitError } from "../errors.js";
import { readInternals } from "../internal/carrier.js";
import type { Volume } from "../internal/volume.js";
import { machineTimeZone } from "../internal/timeZone.js";
import type { Unlogged, WriteEntry } from "../internal/types.js";
import type { Logger } from "../log/logger.js";
import type { CreateData } from "../types.js";

/** The `mode:"plan"` member of {@link CreateData} — the writer's input, carrying
 *  the resolved output, the writable gate, summary, findings, and (out of band,
 *  via `carrier.ts`) the writer's instructions. The writer never reads `log`. */
type PlanData = Unlogged<Extract<CreateData, { mode: "plan" }>>;

/** The `mode:"write"` member of {@link CreateData}; the writer's success shape.
 *  Logging-agnostic: the `log` path is stamped by the SDK boundary, not here. */
type WriteData = Unlogged<Extract<CreateData, { mode: "write" }>>;
import { buildMetadata } from "./metadata.js";
import type { MetadataEntryInput } from "./metadata.js";
import { EntryCompressor, ZipWriter } from "./zipWriter.js";
import type { StreamResult, WriteEntryInput } from "./zipWriter.js";

export interface WriteDeps {
  logger: Logger;
  chunkSize: number;
  signal?: AbortSignal;
  /** The run's bounded file access, built with the same signal. */
  volume: Volume;
}

/** What each streamed entry contributed, gathered for the metadata record. */
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

/**
 * Stream one source file through its compressor into the writer, computing the
 * SHA-256 over the raw bytes when requested. Directories carry no data and are
 * handled by the caller via `addDir`.
 */
async function streamFile(
  writer: ZipWriter,
  source: WriteEntry,
  chunkSize: number,
  level: number,
  hasher: Hash | null,
  deps: WriteDeps,
): Promise<StreamResult> {
  const input = toWriteEntryInput(source);
  return writer.streamEntry(input, async (sink) => {
    const compressor = new EntryCompressor(source.method, sink, chunkSize, level);
    try {
      const file = await deps.volume.open(source.absolutePath, "r");
      try {
        let position = 0;
        for (;;) {
          throwIfAborted(deps.signal);
          const buf = Buffer.allocUnsafe(chunkSize);
          const bytesRead = await file.read(buf, 0, chunkSize, position);
          if (bytesRead === 0) break;
          position += bytesRead;
          const chunk = bytesRead === chunkSize ? buf : buf.subarray(0, bytesRead);
          if (hasher) hasher.update(chunk);
          await compressor.update(chunk);
        }
      } finally {
        await file.release();
      }
    } catch (err) {
      // A cancel, a stall, or a destination fault surfacing through the
      // compressor is already classified; only a raw source error is wrapped.
      if (err instanceof ZipKitError) throw err;
      throw new WriteError("write.read-failed", `cannot read source for ${source.archivePath}`, {
        cause: err,
      });
    }
    return compressor.finish();
  });
}

/** Stream an in-memory buffer (a symlink target or the metadata JSON) as one entry. */
async function streamBuffer(
  writer: ZipWriter,
  input: WriteEntryInput,
  raw: Buffer,
  chunkSize: number,
  level: number,
): Promise<StreamResult> {
  return writer.streamEntry(input, async (sink) => {
    const compressor = new EntryCompressor(input.method, sink, chunkSize, level);
    if (raw.length > 0) await compressor.update(raw);
    return compressor.finish();
  });
}

export async function writeArchive(plan: PlanData, deps: WriteDeps): Promise<WriteData> {
  const internals = readInternals(plan);
  if (!internals) {
    throw new WriteError(
      "write.no-internals",
      "this plan was not produced by ZipKit.plan(); a re-serialized plan cannot be written",
    );
  }
  if (!plan.writable) {
    throw new WriteError(
      "write.not-writable",
      "the plan is not writable: resolve blocking findings or authorize overwrite",
    );
  }

  const { policy, writeEntries, overwrite, comment } = internals;
  const level = policy.compression.level;
  // The zone the DOS local-time field is rendered in: the explicit policy zone,
  // or the host's. Resolved once and recorded in the metadata so the local
  // field is interpretable; the UTC extras and metadata times need no zone.
  const effectiveTimeZone = policy.timezone ?? machineTimeZone();
  const signal = deps.signal;
  throwIfAborted(signal);

  deps.logger.emit({ stage: "write", level: "info", event: "write.start", entries: writeEntries.length });

  const hash = policy.metadata !== false && policy.metadata.hash;
  const createdNs = BigInt(Date.now()) * 1_000_000n;

  // The plan already computed the Zip64 verdict over the full content (entries
  // plus the manifest the writer injects); reuse it as the up-front decision
  // rather than rebuilding and re-estimating here. `finalize()` recomputes the
  // truth from the real offsets and returns it as `zip64`; this up-front value
  // only forces Zip64 on when the estimate already requires it.
  const zip64Needed = plan.summary.zip64;

  const writer = new ZipWriter(
    plan.output,
    { timeZone: effectiveTimeZone, chunkSize: deps.chunkSize, overwrite },
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
        continue;
      }

      const hasher = hash ? createHash("sha256") : null;
      const result = await streamFile(writer, source, deps.chunkSize, level, hasher, deps);
      const entry: StreamedEntry = {
        source,
        crc32: result.crc32,
        compressedSize: result.compressedSize,
      };
      if (hasher) entry.sha256 = hasher.digest("hex");
      streamed.push(entry);
      deps.logger.emit({ stage: "write", level: "debug", event: "entry.written", path: source.archivePath });
    }

    // Phase edge between streaming and finalize: a cancellation that arrived
    // during the last entry has no later boundary to trip, and past finalize the
    // output is renamed into place. Honor it here so a cancelled write leaves
    // nothing behind — the catch's writer.abort() discards the temp file.
    throwIfAborted(signal);

    // The structured record is always built and returned — it is the run's full
    // state. Embedding it as `zipkit.json` is the only part gated by policy.
    const metadataEntries: MetadataEntryInput[] = streamed.map((s) => {
      const input: MetadataEntryInput = {
        writeEntry: s.source,
        crc32: s.crc32,
        compressedSize: s.compressedSize,
      };
      if (s.sha256 !== undefined) input.sha256 = s.sha256;
      return input;
    });
    const metadata = buildMetadata(
      plan,
      policy,
      metadataEntries,
      createdNs,
      effectiveTimeZone,
      comment,
    );

    if (policy.metadata !== false) {
      // A ZIP is a container, so the manifest rides inside it rather than as a
      // loose file that could drift away from the archive. It is generated in
      // memory (it is small) and streamed like any other entry, last.
      const json = Buffer.from(JSON.stringify(metadata, null, 2), "utf8");
      await streamBuffer(
        writer,
        {
          name: policy.metadata.name,
          type: "file",
          method: "deflate",
          uncompressedSize: json.length,
          mtimeNs: createdNs,
          atimeNs: createdNs,
          birthtimeNs: createdNs,
          mode: 0,
        },
        json,
        deps.chunkSize,
        level,
      );
    }

    const final = await writer.finalize(zip64Needed, comment, signal);
    zip64 = final.zip64;
    bytes = final.bytes;

    deps.logger.emit({ stage: "write", level: "info", event: "write.done", bytes, zip64 });

    return {
      mode: "write",
      output: plan.output,
      writable: plan.writable,
      written: true,
      // The exact post-write outcome from finalize.
      bytes,
      zip64,
      // The plan summary, carried verbatim — the same object the embedded manifest
      // holds. Its `zip64` is the pre-write upper-bound estimate; the top-level
      // `zip64` above is the exact outcome, so a caller reads that for the truth.
      summary: plan.summary,
      findings: plan.findings,
      metadata,
    };
  } catch (err) {
    await writer.abort();
    // A stall is reported even when a cancel followed it: it is the real cause,
    // and a stalled publication may still make the archive appear.
    if (err instanceof StallError) throw err;
    if (signal?.aborted) throw toAbortError(signal.reason);
    if (err instanceof WriteError) throw err;
    throw new WriteError("write.failed", `failed to write ${plan.output}`, { cause: err });
  }
}
