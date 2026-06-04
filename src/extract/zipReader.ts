/**
 * The ZIP reader: parse a container into entries and decompress an entry's
 * bytes. It is the shared substrate beneath extraction and validation — neither
 * touches the filesystem here; this layer only turns a buffer into structured
 * entries and inflated content.
 *
 * The central directory is authoritative: names, CRC-32, sizes, the local-header
 * offset, and the timestamp extras are read from there, so the reader is correct
 * even for archives that defer sizes to a data descriptor. Zip64 is resolved
 * transparently — the Zip64 end-of-central-directory for the directory location,
 * and the per-entry Zip64 extra (`0x0001`) for sentinel sizes/offsets.
 */

import zlib from "node:zlib";
import { ReadError } from "../errors.js";

const EOCD_SIG = 0x06054b50;
const EOCD_MIN = 22;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const U16 = 0xffff;
const U32 = 0xffffffff;

export interface ReadEntry {
  /** Final archive path: forward slashes, relative, no trailing slash. */
  archivePath: string;
  type: "file" | "dir" | "symlink";
  method: number; // 0 store, 8 deflate
  crc32: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
  gpFlag: number;
  externalAttr: number;
  dosDate: number;
  dosTime: number;
  /** The central record's extra field, where the timestamp extras live. */
  extra: Buffer;
}

export interface ParsedZip {
  entries: ReadEntry[];
  zip64: boolean;
}

/** Locate an extra field by its 2-byte header id within an extra-field blob. */
export function findExtra(extra: Buffer, id: number): Buffer | null {
  let p = 0;
  while (p + 4 <= extra.length) {
    const tag = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (p + 4 + size > extra.length) break;
    if (tag === id) return extra.subarray(p + 4, p + 4 + size);
    p += 4 + size;
  }
  return null;
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - EOCD_MIN - U16);
  for (let i = buf.length - EOCD_MIN; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ReadError("read.not-zip", "end-of-central-directory record not found");
}

function locateCentralDir(buf: Buffer, eocd: number): {
  count: number;
  cdOffset: number;
  zip64: boolean;
} {
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (count !== U16 && cdOffset !== U32) return { count, cdOffset, zip64: false };

  // A sentinel means the real values live in the Zip64 records. The locator sits
  // immediately before the EOCD and points at the Zip64 EOCD.
  const loc = eocd - 20;
  if (loc >= 0 && buf.readUInt32LE(loc) === ZIP64_LOCATOR_SIG) {
    const z64 = Number(buf.readBigUInt64LE(loc + 8));
    if (z64 >= 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === ZIP64_EOCD_SIG) {
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      return { count, cdOffset, zip64: true };
    }
  }
  throw new ReadError("read.malformed", "Zip64 end-of-central-directory not found");
}

function parseCentral(buf: Buffer, cdOffset: number, count: number): ReadEntry[] {
  const entries: ReadEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new ReadError("read.malformed", `malformed central directory at offset ${p}`);
    }
    const gpFlag = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const dosTime = buf.readUInt16LE(p + 12);
    const dosDate = buf.readUInt16LE(p + 14);
    const crc32 = buf.readUInt32LE(p + 16);
    let compSize = buf.readUInt32LE(p + 20);
    let uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttr = buf.readUInt32LE(p + 38);
    let localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);

    if (compSize === U32 || uncompSize === U32 || localOffset === U32) {
      const z = findExtra(extra, 0x0001);
      if (z) {
        let off = 0;
        if (uncompSize === U32) (uncompSize = Number(z.readBigUInt64LE(off))), (off += 8);
        if (compSize === U32) (compSize = Number(z.readBigUInt64LE(off))), (off += 8);
        if (localOffset === U32) localOffset = Number(z.readBigUInt64LE(off));
      }
    }

    const isDir = rawName.endsWith("/");
    const unixMode = (externalAttr >>> 16) & 0xffff;
    const type: ReadEntry["type"] =
      (unixMode & 0xf000) === 0xa000 ? "symlink" : isDir ? "dir" : "file";

    entries.push({
      archivePath: isDir ? rawName.replace(/\/+$/, "") : rawName,
      type,
      method,
      crc32,
      compSize,
      uncompSize,
      localOffset,
      gpFlag,
      externalAttr,
      dosDate,
      dosTime,
      extra,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function parseZip(buf: Buffer): ParsedZip {
  if (buf.length < EOCD_MIN) throw new ReadError("read.not-zip", "file is too small to be a ZIP");
  const eocd = findEocd(buf);
  const { count, cdOffset, zip64 } = locateCentralDir(buf, eocd);
  return { entries: parseCentral(buf, cdOffset, count), zip64 };
}

/**
 * The decompressed bytes of one entry. Reads the local header for the true data
 * offset (its name/extra lengths can differ from the central record's), then
 * stores or inflates per the method. A directory yields an empty buffer.
 */
export function readEntryData(buf: Buffer, entry: ReadEntry): Buffer {
  if (entry.type === "dir") return Buffer.alloc(0);
  const lo = entry.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOCAL_SIG) {
    throw new ReadError("read.malformed", `bad local header for ${entry.archivePath}`);
  }
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(raw);
    } catch (err) {
      throw new ReadError("read.inflate-failed", `cannot inflate ${entry.archivePath}`, {
        cause: err,
      });
    }
  }
  throw new ReadError(
    "read.unsupported-method",
    `unsupported compression method ${entry.method} for ${entry.archivePath}`,
  );
}
