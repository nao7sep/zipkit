/**
 * Streaming compression and integrity. An entry's bytes flow through here in
 * `chunkSize` pieces: each chunk is hashed into a running CRC-32 (the platform
 * zlib's `crc32`, seeded by the previous value) and, when the method is
 * deflate, fed to a raw-deflate stream whose output chunks are handed to a
 * sink. Stored entries pass through untouched. Nothing is held whole in memory,
 * so an arbitrarily large file compresses in bounded space.
 *
 * The method is decided up front by the compression policy (see
 * `plan/compression.ts`); there is no "store if deflate did not shrink"
 * fallback, because that needs the whole compressed buffer and is incompatible
 * with streaming. A deflated entry may therefore, rarely, be a few bytes larger
 * than its stored form — an accepted trade for unbounded sizes.
 */

import zlib from "node:zlib";

import { awaitDrain } from "../internal/drain.js";

/** A sink for compressed (or stored) output chunks, written in stream order. */
export type ChunkSink = (chunk: Buffer) => Promise<void>;

export interface CompressResult {
  crc32: number;
  /** Bytes handed to the sink (compressed size for deflate, == uncompressed for store). */
  compressedSize: number;
  /** Bytes read from the source. */
  uncompressedSize: number;
}

/**
 * A running compressor for one entry. `update` accepts source chunks and pushes
 * the compressed (or stored) output to the sink; `finish` flushes any trailing
 * deflate output and returns the CRC-32 and the two sizes. One instance per
 * entry — it owns a single zlib stream that cannot be reused.
 */
export class EntryCompressor {
  readonly #sink: ChunkSink;
  readonly #deflate: zlib.DeflateRaw | null;
  /** The one reader of the deflate stream's output (see {@link EntryCompressor.#forward}). */
  readonly #pump: Promise<void>;
  #crc = 0;
  #uncompressedSize = 0;
  #compressedSize = 0;
  #error: unknown;

  constructor(method: "store" | "deflate", sink: ChunkSink, chunkSize: number, level: number) {
    this.#sink = sink;
    if (method === "deflate") {
      // Chunks are fed with plain `write()` and finalized once at `end()` — no
      // mid-stream `Z_SYNC_FLUSH`/`Z_FULL_FLUSH`. That keeps the output within
      // zlib's `deflateBound`, which the writer's per-entry Zip64 decision relies
      // on (a flush per chunk adds bytes and could push a near-4 GiB entry past
      // the bound). Do not introduce intermediate flushes here.
      this.#deflate = zlib.createDeflateRaw({ chunkSize, level });
      this.#pump = this.#forward(this.#deflate);
    } else {
      this.#deflate = null;
      this.#pump = Promise.resolve();
    }
  }

  /**
   * Hand the deflate output to the sink one chunk at a time, in stream order
   * (the sink advances a shared file offset, so overlapping writes would
   * interleave the bytes). Reading only as fast as the sink accepts is what
   * bounds memory: a slow destination leaves output in the stream's buffer,
   * zlib stops, and `update` waits for the drain. After a sink failure the
   * output is still read, and dropped, so a waiting `update` or `finish` is
   * never left behind a stream nobody reads.
   */
  async #forward(deflate: zlib.DeflateRaw): Promise<void> {
    try {
      for await (const chunk of deflate as AsyncIterable<Buffer>) {
        if (this.#error !== undefined) continue;
        this.#compressedSize += chunk.length;
        try {
          await this.#sink(chunk);
        } catch (err) {
          this.#error ??= err;
        }
      }
    } catch (err) {
      this.#error ??= err;
    }
  }

  /** Feed one source chunk: hash it, then store-forward or deflate it. */
  async update(chunk: Buffer): Promise<void> {
    // A sink failure (the destination stalled or failed) ends the entry now,
    // rather than after the rest of the source has been read for nothing.
    if (this.#error !== undefined) throw this.#error;
    this.#crc = zlib.crc32(chunk, this.#crc);
    this.#uncompressedSize += chunk.length;
    if (this.#deflate === null) {
      this.#compressedSize += chunk.length;
      await this.#sink(chunk);
      return;
    }
    // Respect backpressure: when the deflate stream's buffer is full — fast
    // input, or a sink slower than zlib — wait for it to drain before feeding more.
    if (!this.#deflate.write(chunk)) {
      await awaitDrain(this.#deflate);
    }
  }

  /** Flush trailing deflate output and return the CRC and sizes. */
  async finish(): Promise<CompressResult> {
    if (this.#deflate !== null) {
      this.#deflate.end();
      await this.#pump;
    }
    if (this.#error !== undefined) throw this.#error;
    return {
      crc32: this.#crc >>> 0,
      compressedSize: this.#compressedSize,
      uncompressedSize: this.#uncompressedSize,
    };
  }

  /** End an entry that failed before `finish`: stop the stream and wait for the
   *  sink write in flight, so no work on the entry outlives it. */
  async dispose(): Promise<void> {
    this.#deflate?.destroy();
    await this.#pump;
  }
}
