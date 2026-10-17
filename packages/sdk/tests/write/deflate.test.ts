/**
 * The entry compressor's hold on memory and order: deflate output is read only
 * as fast as the sink takes it, so a slow destination stops zlib instead of
 * queueing the compressed file in memory, and the bytes still arrive whole and
 * in order.
 */

import { randomBytes } from "node:crypto";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { EntryCompressor } from "../../../src/sdk/write/deflate.js";

const CHUNK = 64 * 1024;

function chunksOf(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < data.length; at += CHUNK) out.push(data.subarray(at, at + CHUNK));
  return out;
}

/** Whether `promise` settles within `ms` of real time. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([promise.then(() => true, () => true), elapsed]);
  } finally {
    clearTimeout(timer);
  }
}

describe("EntryCompressor", () => {
  it("stops taking input while the sink holds its first chunk, instead of queueing the output", async () => {
    // Random bytes do not compress, so every byte fed becomes about a byte of output.
    const input = randomBytes(16 * 1024 * 1024);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let sinkCalls = 0;
    const compressor = new EntryCompressor("deflate", async () => {
      sinkCalls++;
      await held;
    }, CHUNK, 1);

    let fed = 0;
    for (const chunk of chunksOf(input)) {
      if (!(await settlesWithin(compressor.update(chunk), 200))) break;
      fed += chunk.length;
    }

    expect(sinkCalls).toBe(1);
    // A few stream buffers' worth, not the 16 MiB the source holds.
    expect(fed).toBeLessThan(2 * 1024 * 1024);
    release();
    await compressor.dispose();
  });

  it("delivers the whole stream in order to a sink with random delays", async () => {
    const input = Buffer.concat([randomBytes(1024 * 1024), Buffer.alloc(1024 * 1024, "zipkit ")]);
    const written: Buffer[] = [];
    const compressor = new EntryCompressor("deflate", async (chunk) => {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 2));
      written.push(Buffer.from(chunk));
    }, CHUNK, 6);

    for (const chunk of chunksOf(input)) await compressor.update(chunk);
    const result = await compressor.finish();

    const output = Buffer.concat(written);
    expect(zlib.inflateRawSync(output).equals(input)).toBe(true);
    expect(result).toEqual({ crc32: zlib.crc32(input) >>> 0, compressedSize: output.length, uncompressedSize: input.length });
  });

  it("reports a sink failure on the final flush from finish", async () => {
    const failure = new Error("destination went away");
    let calls = 0;
    const compressor = new EntryCompressor("deflate", async () => {
      calls++;
      throw failure;
    }, CHUNK, 6);

    await compressor.update(Buffer.from("small enough to stay inside zlib until the end"));
    expect(calls).toBe(0);

    await expect(compressor.finish()).rejects.toBe(failure);
  });

  it("ends a failed entry without leaving the sink running", async () => {
    let inFlight = 0;
    let after = 0;
    let disposed = false;
    const compressor = new EntryCompressor("deflate", async () => {
      if (disposed) after++;
      inFlight++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    }, CHUNK, 1);
    for (const chunk of chunksOf(randomBytes(1024 * 1024))) await compressor.update(chunk);

    await compressor.dispose();
    disposed = true;

    expect(inFlight).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(after).toBe(0);
  });
});
