/**
 * A test helper that drives the streaming {@link ZipWriter} from in-memory
 * entries, the way the SDK's write edge does, but with the data supplied as a
 * buffer rather than streamed from disk. It writes a real archive file (the
 * writer's only output mode now) and returns its path, so writer byte-contract
 * tests can read it back with `readZipFile` and assert the same guarantees the
 * old in-memory `buildZip` allowed.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EntryCompressor, ZipWriter } from "../../src/write/zipWriter.js";
import type { WriteEntryInput, ZipWriterOptions } from "../../src/write/zipWriter.js";

/** One entry plus the raw (uncompressed) bytes the writer should stream. */
export interface EntryWithData extends WriteEntryInput {
  /** Raw bytes for a file/symlink; ignored for a directory. */
  raw: Buffer;
}

export interface BuiltZip {
  path: string;
  zip64: boolean;
  bytes: number;
}

/**
 * Writer options plus a test-only `zip64` force flag. The production writer
 * derives the Zip64 need from the final entry set (a real over-4GB entry can't
 * be faked in a unit test), so tests pass the force flag explicitly to exercise
 * the Zip64 container structures.
 */
export interface BuildOptions extends ZipWriterOptions {
  zip64?: boolean;
}

/**
 * Build an archive file from the given entries with the streaming writer. The
 * method on each entry decides store vs deflate; the writer computes the CRC and
 * sizes from the streamed bytes, exactly as the production path does.
 */
export async function buildZipFile(
  entries: EntryWithData[],
  options: BuildOptions,
): Promise<BuiltZip> {
  const { zip64: forceZip64 = false, ...writerOptions } = options;
  const dir = mkdtempSync(path.join(tmpdir(), "zk-writer-"));
  const output = path.join(dir, "a.zip");
  const writer = new ZipWriter(output, writerOptions);
  await writer.open();
  try {
    for (const entry of entries) {
      if (entry.type === "dir") {
        await writer.addDir(entry);
        continue;
      }
      await writer.streamEntry(entry, async (sink) => {
        const compressor = new EntryCompressor(entry.method, sink, options.chunkSize);
        if (entry.raw.length > 0) await compressor.update(entry.raw);
        return compressor.finish();
      });
    }
    const { zip64, bytes } = await writer.finalize(forceZip64);
    return { path: output, zip64, bytes };
  } catch (err) {
    await writer.abort();
    throw err;
  }
}
