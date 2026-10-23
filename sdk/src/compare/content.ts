/**
 * The content half of the check before the originals are removed: every file
 * and link the fresh scan found unchanged by type, size and modification time
 * is read again and its bytes compared with what the archive recorded, the
 * SHA-256 where the manifest holds one and the CRC-32 otherwise. Size and time
 * alone pass a same-size edit whose time was kept (a sync tool, `touch -r`), and
 * removal is the one step that loses data when the check is wrong, so the
 * originals are read once more.
 *
 * A link's content is its target, as the writer stored it. Reads go through the
 * run's bounded {@link Volume} and run concurrently within the pool.
 */

import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { fsFailure, isStall, throwIfAborted } from "../errors.ts";
import type { WriteEntry } from "../internal/types.ts";
import type { Volume } from "../internal/volume.ts";
import { Meter } from "../progress.ts";
import type { ManifestRecord } from "../read/verify.ts";
import type { ProgressCounts } from "../types.ts";

export interface RecheckDeps {
  volume: Volume;
  limit: <T>(fn: () => Promise<T>) => Promise<T>;
  chunkSize: number;
  signal?: AbortSignal | undefined;
  onProgress?: ((counts: ProgressCounts) => void) | undefined;
}

/** What one source holds now, both ways a record can name it. */
interface Digest {
  sha256?: string | undefined;
  crc32?: number | undefined;
}

interface DigestNeeds { sha256: boolean; crc32: boolean }

async function digestFile(entry: WriteEntry, needs: DigestNeeds, deps: RecheckDeps, meter: Meter): Promise<Digest> {
  const hash = needs.sha256 ? createHash("sha256") : null;
  let crc = 0;
  let file;
  try {
    file = await deps.volume.open(entry.absolutePath, "r");
  } catch (err) {
    throw fsFailure(err, entry.absolutePath);
  }
  try {
    const buf = Buffer.allocUnsafe(deps.chunkSize);
    for (let position = 0; ; ) {
      throwIfAborted(deps.signal);
      const bytesRead = await file.read(buf, 0, buf.length, position);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      hash?.update(chunk);
      if (needs.crc32) crc = crc32(chunk, crc);
      position += bytesRead;
      meter.bytes(bytesRead);
    }
  } catch (err) {
    throw fsFailure(err, entry.absolutePath);
  } finally {
    await file.release();
  }
  return { sha256: hash?.digest("hex"), crc32: needs.crc32 ? crc >>> 0 : undefined };
}

function digestBytes(bytes: Buffer, needs: DigestNeeds): Digest {
  return {
    sha256: needs.sha256 ? createHash("sha256").update(bytes).digest("hex") : undefined,
    crc32: needs.crc32 ? crc32(bytes) >>> 0 : undefined,
  };
}

/** Whether the source matches its record: by SHA-256 when one was recorded, else by CRC-32. */
function matches(digest: Digest, record: ManifestRecord): boolean {
  return record.sha256 !== undefined ? digest.sha256 === record.sha256 : digest.crc32 === record.crc32 >>> 0;
}

/**
 * The source paths of `fresh` files and links whose content matches no record
 * of the same source path, type, size and modification time, each record
 * vouching for one source at most. Folders hold no content and are skipped.
 * Records are paired by source path, not archive path, since a removal check
 * of the inputs still present can lay them out differently in the archive.
 */
export async function recheckContent(
  fresh: readonly WriteEntry[],
  records: readonly ManifestRecord[],
  deps: RecheckDeps,
): Promise<string[]> {
  const bySource = new Map<string, ManifestRecord[]>();
  for (const record of records) {
    if (record.type === "dir") continue;
    const list = bySource.get(record.sourcePath);
    if (list) list.push(record);
    else bySource.set(record.sourcePath, [record]);
  }
  const checked = fresh.filter((entry) => entry.type !== "dir");
  const meter = new Meter(
    "recheck",
    { entries: checked.length, bytes: checked.reduce((sum, e) => sum + (e.type === "file" ? e.size : 0), 0) },
    deps.onProgress,
  );
  const changed: string[] = [];
  // `allSettled`, as verification does, so no read is still using the volume
  // when the check returns; a stall is reported ahead of what it caused.
  const settled = await Promise.allSettled(
    checked.map((entry) =>
      deps.limit(async () => {
        throwIfAborted(deps.signal);
        const candidates = (bySource.get(entry.sourcePath) ?? []).filter((record) =>
          record.type === entry.type && record.size === entry.size && record.mtime.ns === entry.mtimeNs.toString());
        if (candidates.length === 0) {
          changed.push(entry.sourcePath);
        } else {
          // Shared source names can have mixed records. Read once, calculating
          // only the checksums that these candidates can actually compare.
          const needs = {
            sha256: candidates.some(record => record.sha256 !== undefined),
            crc32: candidates.some(record => record.sha256 === undefined),
          };
          const digest = entry.type === "symlink"
            ? digestBytes(Buffer.from(entry.linkTarget ?? "", "utf8"), needs)
            : await digestFile(entry, needs, deps, meter);
          // Claimed after the read, from what is still unclaimed: a source
          // sharing this path may have taken a record while this one was read.
          const pool = bySource.get(entry.sourcePath)!;
          const match = pool.findIndex((record) => candidates.includes(record) && matches(digest, record));
          if (match === -1) changed.push(entry.sourcePath);
          else pool.splice(match, 1);
        }
        meter.entry();
      }),
    ),
  );
  const failures = settled.flatMap((s) => (s.status === "rejected" ? [s.reason as unknown] : []));
  const failure = failures.find((f) => isStall(f)) ?? failures[0];
  if (failure !== undefined) throw failure;
  meter.finish();
  return [...new Set(changed)].sort();
}
