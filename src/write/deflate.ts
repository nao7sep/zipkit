/**
 * Compression and integrity. Deflate uses the platform zlib's raw
 * deflate and the matching CRC-32 from the same library. Deflate falls back to
 * store when it does not shrink the data, so a compressed entry is never larger
 * than its stored form.
 */

import { promisify } from "node:util";
import zlib from "node:zlib";

const deflateRaw = promisify(zlib.deflateRaw);

export interface Compressed {
  method: "store" | "deflate";
  crc32: number;
  data: Buffer;
  /** The uncompressed size, regardless of the method chosen. */
  size: number;
}

export async function compress(raw: Buffer, requested: "store" | "deflate"): Promise<Compressed> {
  const crc32 = zlib.crc32(raw);
  if (requested === "store") {
    return { method: "store", crc32, data: raw, size: raw.length };
  }
  const deflated = await deflateRaw(raw);
  if (deflated.length >= raw.length) {
    return { method: "store", crc32, data: raw, size: raw.length };
  }
  return { method: "deflate", crc32, data: deflated, size: raw.length };
}
