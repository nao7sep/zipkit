/**
 * The write edge. It consumes a writable plan, reads each entry's bytes,
 * compresses and hashes them, frames the archive with the in-house writer, and
 * writes it atomically — a temporary file in the same directory, then a
 * same-filesystem rename. The metadata file is injected as an entry (inside) or
 * written as a sidecar. The writer instructions ride on the plan (see
 * `carrier.ts`), so `write(plan)` needs no second argument.
 *
 * `writable` is the gate: a non-writable plan throws `WriteError`, with no
 * override for the error tier.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { throwIfAborted, toAbortError, WriteError } from "../errors.js";
import { readInternals } from "../internal/carrier.js";
import type { WriteEntry } from "../internal/types.js";
import type { Logger } from "../log/logger.js";
import type { Plan, WriteResult } from "../types.js";
import { computeZip64Need } from "../plan/zip64.js";
import { compress } from "./deflate.js";
import { buildMetadata } from "./metadata.js";
import type { MetadataEntryInput } from "./metadata.js";
import { buildZip } from "./zipWriter.js";
import type { PreparedEntry } from "./zipWriter.js";

export interface WriteDeps {
  limit: <T>(fn: () => Promise<T>) => Promise<T>;
  logger: Logger;
  signal?: AbortSignal;
}

interface Prepared {
  entry: PreparedEntry;
  source: WriteEntry;
  crc32: number;
  sha256?: string;
}

const EMPTY = Buffer.alloc(0);

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function prepareEntry(
  source: WriteEntry,
  hash: boolean,
  signal: AbortSignal | undefined,
): Promise<Prepared> {
  if (source.type === "dir") {
    return {
      entry: {
        name: source.archivePath,
        type: "dir",
        method: "store",
        crc32: 0,
        data: EMPTY,
        uncompressedSize: 0,
        mtimeNs: source.mtimeNs,
        mode: source.mode,
      },
      source,
      crc32: 0,
    };
  }

  if (source.type === "symlink") {
    const raw = Buffer.from(source.linkTarget ?? "", "utf8");
    const compressed = await compress(raw, "store");
    const prepared: Prepared = {
      entry: {
        name: source.archivePath,
        type: "symlink",
        method: compressed.method,
        crc32: compressed.crc32,
        data: compressed.data,
        uncompressedSize: compressed.size,
        mtimeNs: source.mtimeNs,
        mode: source.mode,
      },
      source,
      crc32: compressed.crc32,
    };
    if (hash) prepared.sha256 = sha256(raw);
    return prepared;
  }

  let raw: Buffer;
  try {
    raw = await readFile(source.absolutePath);
  } catch (err) {
    throw new WriteError("write.read-failed", `cannot read source for ${source.archivePath}`, {
      cause: err,
    });
  }
  throwIfAborted(signal);
  const compressed = await compress(raw, source.method);
  const prepared: Prepared = {
    entry: {
      name: source.archivePath,
      type: "file",
      method: compressed.method,
      crc32: compressed.crc32,
      data: compressed.data,
      uncompressedSize: compressed.size,
      mtimeNs: source.mtimeNs,
      mode: source.mode,
    },
    source,
    crc32: compressed.crc32,
  };
  if (hash) prepared.sha256 = sha256(raw);
  return prepared;
}

export async function writeArchive(plan: Plan, deps: WriteDeps): Promise<WriteResult> {
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

  const { policy, writeEntries } = internals;
  const signal = deps.signal;
  throwIfAborted(signal);

  deps.logger.emit("write", "info", "write.start", { data: { entries: writeEntries.length } });

  const hash = policy.metadata !== false && policy.metadata.hash;
  let prepared: Prepared[];
  try {
    prepared = await Promise.all(
      writeEntries.map((source) =>
        deps.limit(async () => {
          const result = await prepareEntry(source, hash, signal);
          deps.logger.emit("write", "debug", "entry.written", { path: source.archivePath });
          return result;
        }),
      ),
    );
  } catch (err) {
    if (signal?.aborted) throw toAbortError(signal.reason);
    throw err;
  }

  const zipEntries: PreparedEntry[] = prepared.map((p) => p.entry);
  let sidecar: { path: string; bytes: Buffer } | undefined;

  if (policy.metadata !== false) {
    const metadataEntries: MetadataEntryInput[] = prepared.map((p) => {
      const input: MetadataEntryInput = { writeEntry: p.source, crc32: p.crc32 };
      if (p.sha256 !== undefined) input.sha256 = p.sha256;
      return input;
    });
    const createdNs = BigInt(Date.now()) * 1_000_000n;
    const document = buildMetadata(plan, policy, metadataEntries, createdNs);
    const json = Buffer.from(JSON.stringify(document, null, 2), "utf8");

    if (policy.metadata.placement === "inside") {
      const compressed = await compress(json, "deflate");
      zipEntries.push({
        name: policy.metadata.name,
        type: "file",
        method: compressed.method,
        crc32: compressed.crc32,
        data: compressed.data,
        uncompressedSize: compressed.size,
        mtimeNs: createdNs,
        mode: 0,
      });
    } else {
      const sidecarPath = path.join(path.dirname(plan.output), policy.metadata.name);
      if (path.resolve(sidecarPath) === path.resolve(plan.output)) {
        throw new WriteError(
          "write.sidecar-collision",
          `the metadata sidecar name "${policy.metadata.name}" collides with the output archive`,
        );
      }
      sidecar = { path: sidecarPath, bytes: json };
    }
  }

  if (policy.deterministic) {
    zipEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // Decide Zip64 over the final entry set, which includes the injected metadata
  // entry that the plan-time estimate could not see. Under "never" this is a
  // hard gate: emit a clear error rather than silently producing a Zip64
  // archive the caller forbade.
  const zip64Needed = computeZip64Need(
    zipEntries.map((e) => ({ name: e.name, size: e.uncompressedSize, isDir: e.type === "dir" })),
  );
  if (policy.zip64 === "never" && zip64Needed) {
    throw new WriteError(
      "write.zip64-required",
      "the archive exceeds 32-bit ZIP limits but Zip64 is disabled",
    );
  }
  const { bytes, zip64 } = buildZip(zipEntries, {
    zip64: policy.zip64 === "always" || zip64Needed,
    deterministic: policy.deterministic,
    preserveTimestamps: policy.timestamps === "preserve",
  });

  try {
    await writeFileAtomic(plan.output, bytes);
  } catch (err) {
    throw new WriteError("write.atomic-failed", `failed to write ${plan.output}`, { cause: err });
  }

  if (sidecar) {
    try {
      await writeFileAtomic(sidecar.path, sidecar.bytes);
    } catch (err) {
      throw new WriteError("write.atomic-failed", `failed to write sidecar ${sidecar.path}`, {
        cause: err,
      });
    }
  }

  deps.logger.emit("write", "info", "write.done", { data: { bytes: bytes.length, zip64 } });

  return {
    output: plan.output,
    zip64,
    entries: zipEntries.length,
    excluded: plan.summary.excluded,
    bytes: bytes.length,
    plan,
  };
}
