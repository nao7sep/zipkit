/**
 * The ZIP reader: parse a container's directory and stream an entry's bytes,
 * all through positioned reads on an open file descriptor so the whole archive
 * is never held in memory. It is the shared substrate beneath extraction and
 * validation — this layer turns a file into structured entries and pipes
 * inflated content to a sink; the filesystem destination is the caller's job.
 *
 * The central directory is authoritative: names, CRC-32, sizes, the local-header
 * offset, and the timestamp extras are read from there, so the reader is correct
 * even for archives that defer sizes to a data descriptor. Zip64 is resolved
 * transparently — the Zip64 end-of-central-directory for the directory location,
 * and the per-entry Zip64 extra (`0x0001`) for sentinel sizes/offsets.
 */

import { createReadStream, read as fsRead } from "node:fs";
import { promisify } from "node:util";
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
// The largest tail we ever need to scan for the EOCD: the 22-byte record plus
// the maximum 65535-byte trailing comment, plus the 20-byte Zip64 locator that
// can precede it.
const MAX_EOCD_SEARCH = EOCD_MIN + U16 + 20;

const readFd = promisify(
  (fd: number, buffer: Buffer, offset: number, length: number, position: number,
   cb: (err: NodeJS.ErrnoException | null, bytesRead: number) => void) =>
    fsRead(fd, buffer, offset, length, position, (err, bytesRead) => cb(err, bytesRead)),
);

/** Read exactly `length` bytes at `position`, erroring on a short read. */
async function readExact(fd: number, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = await readFd(fd, buf, got, length - got, position + got);
    if (n === 0) throw new ReadError("read.malformed", "unexpected end of archive");
    got += n;
  }
  return buf;
}

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

/** Find the EOCD offset within a buffer that holds the archive's tail. */
function findEocdInTail(tail: Buffer): number {
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ReadError("read.not-zip", "end-of-central-directory record not found");
}

function locateCentralDir(tail: Buffer, tailStart: number, eocdInTail: number): {
  count: number;
  cdOffset: number;
  zip64: boolean;
} {
  let count = tail.readUInt16LE(eocdInTail + 10);
  let cdOffset = tail.readUInt32LE(eocdInTail + 16);
  if (count !== U16 && cdOffset !== U32) return { count, cdOffset, zip64: false };

  // A sentinel means the real values live in the Zip64 records. The locator sits
  // immediately before the EOCD and points at the Zip64 EOCD.
  const locInTail = eocdInTail - 20;
  if (locInTail >= 0 && tail.readUInt32LE(locInTail) === ZIP64_LOCATOR_SIG) {
    const z64 = Number(tail.readBigUInt64LE(locInTail + 8));
    const z64InTail = z64 - tailStart;
    if (
      z64InTail >= 0 &&
      z64InTail + 56 <= tail.length &&
      tail.readUInt32LE(z64InTail) === ZIP64_EOCD_SIG
    ) {
      count = Number(tail.readBigUInt64LE(z64InTail + 32));
      cdOffset = Number(tail.readBigUInt64LE(z64InTail + 48));
      return { count, cdOffset, zip64: true };
    }
  }
  throw new ReadError("read.malformed", "Zip64 end-of-central-directory not found");
}

function parseCentral(cd: Buffer, count: number): ReadEntry[] {
  const entries: ReadEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new ReadError("read.malformed", `malformed central directory at offset ${p}`);
    }
    const gpFlag = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const dosTime = cd.readUInt16LE(p + 12);
    const dosDate = cd.readUInt16LE(p + 14);
    const crc32 = cd.readUInt32LE(p + 16);
    let compSize = cd.readUInt32LE(p + 20);
    let uncompSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const externalAttr = cd.readUInt32LE(p + 38);
    let localOffset = cd.readUInt32LE(p + 42);
    const rawName = cd.toString("utf8", p + 46, p + 46 + nameLen);
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);

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

/**
 * Parse a ZIP's directory from an open fd: positioned-read the archive tail to
 * find the EOCD (and any Zip64 records), then read the central-directory region
 * and decode each record. Nothing but the directory ever enters memory.
 */
export async function parseZip(fd: number, fileSize: number): Promise<ParsedZip> {
  if (fileSize < EOCD_MIN) throw new ReadError("read.not-zip", "file is too small to be a ZIP");
  const tailLen = Math.min(fileSize, MAX_EOCD_SEARCH);
  const tailStart = fileSize - tailLen;
  const tail = await readExact(fd, tailStart, tailLen);
  const eocdInTail = findEocdInTail(tail);
  const { count, cdOffset, zip64 } = locateCentralDir(tail, tailStart, eocdInTail);

  // The central directory ends where its EOCD (or Zip64 EOCD) begins; read just
  // that region rather than the whole file.
  const cdEnd = tailStart + (zip64 ? eocdInTail - 20 : eocdInTail);
  const cdLen = cdEnd - cdOffset;
  if (cdOffset < 0 || cdLen < 0 || cdEnd > fileSize) {
    throw new ReadError("read.malformed", "central directory location is out of range");
  }
  const cd = await readExact(fd, cdOffset, cdLen);
  return { entries: parseCentral(cd, count), zip64 };
}

/** The byte offset of an entry's data, after its local header, name, and extra. */
async function entryDataOffset(fd: number, entry: ReadEntry): Promise<number> {
  const header = await readExact(fd, entry.localOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_SIG) {
    throw new ReadError("read.malformed", `bad local header for ${entry.archivePath}`);
  }
  const nameLen = header.readUInt16LE(26);
  const extraLen = header.readUInt16LE(28);
  return entry.localOffset + 30 + nameLen + extraLen;
}

/** A sink for an entry's decompressed output chunks, in stream order. */
export type DataSink = (chunk: Buffer) => Promise<void>;

export interface EntryReadResult {
  /** CRC-32 over the decompressed bytes, for comparison with the stored value. */
  crc32: number;
  uncompressedSize: number;
}

/**
 * Stream one entry's decompressed bytes to `sink`, computing the CRC-32 as it
 * goes (the caller compares it to the stored value before trusting any output).
 * The compressed data is read from the fd in `chunkSize` pieces and inflated (or
 * passed through for stored entries) so memory stays bounded for any size. A
 * directory yields nothing.
 */
export async function readEntryData(
  fd: number,
  entry: ReadEntry,
  sink: DataSink,
  chunkSize: number,
): Promise<EntryReadResult> {
  if (entry.type === "dir") return { crc32: 0, uncompressedSize: 0 };
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ReadError(
      "read.unsupported-method",
      `unsupported compression method ${entry.method} for ${entry.archivePath}`,
    );
  }
  // A zero-length entry (an empty file, or a deflate stream with no payload) has
  // no compressed bytes to read; a read stream with `end < start` is invalid, so
  // short-circuit. CRC-32 over no bytes is 0, which matches the stored value.
  if (entry.compSize === 0) return { crc32: 0, uncompressedSize: 0 };
  const start = await entryDataOffset(fd, entry);
  const reader = createReadStream("", {
    fd,
    autoClose: false,
    start,
    end: start + entry.compSize - 1,
    highWaterMark: chunkSize,
  });

  let crc = 0;
  let uncompressedSize = 0;
  const consume = async (chunk: Buffer): Promise<void> => {
    crc = zlib.crc32(chunk, crc);
    uncompressedSize += chunk.length;
    await sink(chunk);
  };

  if (entry.method === 0) {
    for await (const chunk of reader) await consume(chunk as Buffer);
    return { crc32: crc >>> 0, uncompressedSize };
  }

  const inflate = zlib.createInflateRaw({ chunkSize });
  // Serialize sink writes so inflated bytes reach the destination in order; the
  // sink may pause on backpressure, and overlapping writes would interleave.
  let chain: Promise<void> = Promise.resolve();
  let sinkError: unknown;
  inflate.on("data", (chunk: Buffer) => {
    chain = chain.then(() => consume(chunk).catch((err) => void (sinkError ??= err)));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      inflate.on("end", resolve);
      inflate.on("error", reject);
      reader.on("error", reject);
      reader.on("data", (chunk) => {
        if (!inflate.write(chunk)) {
          reader.pause();
          inflate.once("drain", () => reader.resume());
        }
      });
      reader.on("end", () => inflate.end());
    });
    await chain;
  } catch (err) {
    throw new ReadError("read.inflate-failed", `cannot inflate ${entry.archivePath}`, {
      cause: err,
    });
  }
  if (sinkError !== undefined) throw sinkError;
  return { crc32: crc >>> 0, uncompressedSize };
}

/**
 * Read one entry's full decompressed bytes into a buffer. Reserved for small,
 * structural entries — the embedded manifest — where the content must be parsed
 * whole; the extraction path streams instead so it never buffers an entry.
 */
export async function readEntryBuffer(fd: number, entry: ReadEntry): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await readEntryData(fd, entry, async (chunk) => void chunks.push(chunk), 65536);
  return Buffer.concat(chunks);
}
