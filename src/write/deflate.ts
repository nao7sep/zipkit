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
  readonly #method: "store" | "deflate";
  readonly #sink: ChunkSink;
  readonly #deflate: zlib.DeflateRaw | null;
  #crc = 0;
  #uncompressedSize = 0;
  #compressedSize = 0;
  /** A serial chain of sink writes: each output chunk waits for the previous to
   *  finish, so the bytes reach the sink in deflate-stream order. */
  #chain: Promise<void> = Promise.resolve();
  #error: unknown;

  constructor(method: "store" | "deflate", sink: ChunkSink, chunkSize: number) {
    this.#method = method;
    this.#sink = sink;
    if (method === "deflate") {
      this.#deflate = zlib.createDeflateRaw({ chunkSize });
      // Output chunks arrive on the stream's "data" events, already in order.
      // Forward each to the sink strictly sequentially — the sink advances a
      // shared file offset, so overlapping writes would interleave the bytes.
      this.#deflate.on("data", (chunk: Buffer) => {
        this.#compressedSize += chunk.length;
        this.#chain = this.#chain.then(() =>
          this.#sink(chunk).catch((err) => void (this.#error ??= err)),
        );
      });
      this.#deflate.on("error", (err) => void (this.#error ??= err));
    } else {
      this.#deflate = null;
    }
  }

  /** Feed one source chunk: hash it, then store-forward or deflate it. */
  async update(chunk: Buffer): Promise<void> {
    this.#crc = zlib.crc32(chunk, this.#crc);
    this.#uncompressedSize += chunk.length;
    if (this.#deflate === null) {
      this.#compressedSize += chunk.length;
      await this.#sink(chunk);
      return;
    }
    // Respect backpressure: when the deflate stream's buffer is full, wait for
    // it to drain before feeding more, so memory stays bounded under fast input.
    if (!this.#deflate.write(chunk)) {
      await new Promise<void>((resolve) => this.#deflate!.once("drain", resolve));
    }
  }

  /** Flush trailing deflate output and return the CRC and sizes. */
  async finish(): Promise<CompressResult> {
    if (this.#deflate !== null) {
      await new Promise<void>((resolve, reject) => {
        this.#deflate!.once("end", resolve);
        this.#deflate!.once("error", reject);
        this.#deflate!.end();
      });
      await this.#chain;
    }
    if (this.#error !== undefined) throw this.#error;
    return {
      crc32: this.#crc >>> 0,
      compressedSize: this.#compressedSize,
      uncompressedSize: this.#uncompressedSize,
    };
  }
}
