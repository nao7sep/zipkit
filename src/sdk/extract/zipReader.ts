/**
 * The ZIP reader: parse a container's directory and stream an entry's bytes,
 * all through positioned reads on an open, bounded file handle so the whole archive
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

import { constants as bufferConstants } from "node:buffer";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { ReadError, ZipKitError } from "../errors.js";
import type { VolumeFile } from "../internal/volume.js";

const EOCD_SIG = 0x06054b50;
const EOCD_MIN = 22;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const U16 = 0xffff;
const U32 = 0xffffffff;
// The largest tail needed to locate the classic EOCD and, when present, its
// immediately preceding Zip64 locator. The Zip64 EOCD itself is read from the
// locator's absolute offset, so even a maximum comment cannot push it out of the
// in-memory search window.
const MAX_EOCD_SEARCH = EOCD_MIN + U16 + 20;

/** Read exactly `length` bytes at `position`, erroring on a short read. */
async function readExact(file: VolumeFile, position: number, length: number): Promise<Buffer> {
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > bufferConstants.MAX_LENGTH
  ) {
    throw new ReadError("read.malformed", "archive byte range is not safely addressable");
  }
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = await file.read(buf, got, length - got, position + got);
    if (n === 0) throw new ReadError("read.malformed", "unexpected end of archive");
    got += n;
  }
  return buf;
}

function safeNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ReadError("read.malformed", `${field} exceeds the safe integer range`);
  }
  return Number(value);
}

function safeAdd(left: number, right: number, field: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < 0) {
    throw new ReadError("read.malformed", `${field} exceeds the safe integer range`);
  }
  return sum;
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

/**
 * Find the EOCD offset within a buffer that holds the archive's tail. A match
 * must also have a comment-length field that accounts for exactly the bytes after
 * the 22-byte record — the tail ends at EOF, so that count is `tail.length - i -
 * EOCD_MIN`. Without this check a comment that happens to contain the 4-byte EOCD
 * signature would be picked as a false EOCD (the scan runs end-to-start), and an
 * otherwise-valid archive would be misread as malformed.
 */
function findEocdInTail(tail: Buffer): number {
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG && tail.readUInt16LE(i + 20) === tail.length - i - EOCD_MIN) {
      return i;
    }
  }
  throw new ReadError("read.not-zip", "end-of-central-directory record not found");
}

async function locateCentralDir(
  file: VolumeFile,
  tail: Buffer,
  tailStart: number,
  eocdInTail: number,
): Promise<{
  count: number;
  cdOffset: number;
  cdEnd: number;
  zip64: boolean;
}> {
  let count = tail.readUInt16LE(eocdInTail + 10);
  const cdSize = tail.readUInt32LE(eocdInTail + 12);
  let cdOffset = tail.readUInt32LE(eocdInTail + 16);
  const eocdOffset = tailStart + eocdInTail;
  if (count !== U16 && cdSize !== U32 && cdOffset !== U32) {
    return { count, cdOffset, cdEnd: eocdOffset, zip64: false };
  }

  // A sentinel means the real values live in the Zip64 records. The locator sits
  // immediately before the EOCD and points at the Zip64 EOCD.
  const locInTail = eocdInTail - 20;
  if (locInTail >= 0 && tail.readUInt32LE(locInTail) === ZIP64_LOCATOR_SIG) {
    const z64 = safeNumber(tail.readBigUInt64LE(locInTail + 8), "Zip64 directory offset");
    const locatorOffset = tailStart + locInTail;
    const minimumRecordEnd = safeAdd(z64, 56, "Zip64 end-record range");
    if (z64 >= 0 && minimumRecordEnd <= locatorOffset) {
      const record = await readExact(file, z64, 56);
      if (record.readUInt32LE(0) !== ZIP64_EOCD_SIG) {
        throw new ReadError("read.malformed", "Zip64 end-of-central-directory not found");
      }
      const recordSize = safeNumber(record.readBigUInt64LE(4), "Zip64 end-record length");
      const recordEnd = safeAdd(z64, 12 + recordSize, "Zip64 end-record range");
      if (recordSize < 44 || recordEnd !== locatorOffset) {
        throw new ReadError("read.malformed", "invalid Zip64 end-of-central-directory length");
      }
      count = safeNumber(record.readBigUInt64LE(32), "Zip64 entry count");
      cdOffset = safeNumber(record.readBigUInt64LE(48), "Zip64 central-directory offset");
      return { count, cdOffset, cdEnd: z64, zip64: true };
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
    const recordEnd = p + 46 + nameLen + extraLen + commentLen;
    if (!Number.isSafeInteger(recordEnd) || recordEnd > cd.length) {
      throw new ReadError("read.malformed", `truncated central-directory record at offset ${p}`);
    }
    const rawName = cd.toString("utf8", p + 46, p + 46 + nameLen);
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);

    if (compSize === U32 || uncompSize === U32 || localOffset === U32) {
      const z = findExtra(extra, 0x0001);
      const required =
        (uncompSize === U32 ? 8 : 0) +
        (compSize === U32 ? 8 : 0) +
        (localOffset === U32 ? 8 : 0);
      if (!z || z.length < required) {
        throw new ReadError("read.malformed", `missing or truncated Zip64 extra for ${rawName}`);
      }
      let off = 0;
      if (uncompSize === U32) {
        uncompSize = safeNumber(z.readBigUInt64LE(off), `uncompressed size for ${rawName}`);
        off += 8;
      }
      if (compSize === U32) {
        compSize = safeNumber(z.readBigUInt64LE(off), `compressed size for ${rawName}`);
        off += 8;
      }
      if (localOffset === U32) {
        localOffset = safeNumber(z.readBigUInt64LE(off), `local-header offset for ${rawName}`);
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
    p = recordEnd;
  }
  return entries;
}

/**
 * Parse a ZIP's directory from an open file: positioned-read the archive tail to
 * find the EOCD (and any Zip64 records), then read the central-directory region
 * and decode each record. Nothing but the directory ever enters memory.
 */
export async function parseZip(file: VolumeFile, fileSize: number): Promise<ParsedZip> {
  if (fileSize < EOCD_MIN) throw new ReadError("read.not-zip", "file is too small to be a ZIP");
  const tailLen = Math.min(fileSize, MAX_EOCD_SEARCH);
  const tailStart = fileSize - tailLen;
  const tail = await readExact(file, tailStart, tailLen);
  const eocdInTail = findEocdInTail(tail);
  const { count, cdOffset, cdEnd, zip64 } = await locateCentralDir(
    file,
    tail,
    tailStart,
    eocdInTail,
  );

  // The central directory ends where its classic or Zip64 EOCD begins; read just
  // that region rather than the whole file.
  const cdLen = cdEnd - cdOffset;
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Number.isSafeInteger(cdOffset) ||
    cdOffset < 0 ||
    !Number.isSafeInteger(cdLen) ||
    cdLen < 0 ||
    cdEnd > fileSize
  ) {
    throw new ReadError("read.malformed", "central directory location is out of range");
  }
  const cd = await readExact(file, cdOffset, cdLen);
  return { entries: parseCentral(cd, count), zip64 };
}

/** The byte offset of an entry's data, after its local header, name, and extra. */
async function entryDataOffset(file: VolumeFile, entry: ReadEntry): Promise<number> {
  const header = await readExact(file, entry.localOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_SIG) {
    throw new ReadError("read.malformed", `bad local header for ${entry.archivePath}`);
  }
  const nameLen = header.readUInt16LE(26);
  const extraLen = header.readUInt16LE(28);
  return safeAdd(entry.localOffset, 30 + nameLen + extraLen, `data offset for ${entry.archivePath}`);
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
 * The compressed data is read from the handle in `chunkSize` pieces and inflated (or
 * passed through for stored entries) so memory stays bounded for any size. A
 * directory yields nothing.
 */
export async function readEntryData(
  file: VolumeFile,
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
  if (entry.compSize === 0) {
    if (entry.uncompSize !== 0) {
      throw new ReadError(
        "read.size-mismatch",
        `uncompressed size does not match the declared size for ${entry.archivePath}`,
      );
    }
    return { crc32: 0, uncompressedSize: 0 };
  }
  const start = await entryDataOffset(file, entry);
  const endExclusive = safeAdd(start, entry.compSize, `compressed data range for ${entry.archivePath}`);

  let crc = 0;
  let uncompressedSize = 0;
  const consume = async (chunk: Buffer): Promise<void> => {
    crc = zlib.crc32(chunk, crc);
    uncompressedSize += chunk.length;
    if (!Number.isSafeInteger(uncompressedSize) || uncompressedSize > entry.uncompSize) {
      throw new ReadError(
        "read.size-mismatch",
        `uncompressed size exceeds the declared size for ${entry.archivePath}`,
      );
    }
    await sink(chunk);
  };

  const source = compressedChunks(file, start, endExclusive, chunkSize);
  if (entry.method === 0) {
    for await (const chunk of source) await consume(chunk);
  } else {
    // The pipeline tears every stage down on the first failure from any of them
    // — a read that stalled or was cancelled, a corrupt stream, or the sink's own
    // throw (an abort, a size overrun) — so a large entry stops at the failing
    // chunk rather than draining. The handle is shared across concurrent
    // entries and is never closed here.
    try {
      await pipeline(
        Readable.from(source),
        zlib.createInflateRaw({ chunkSize }),
        async (inflated: AsyncIterable<Buffer>) => {
          for await (const chunk of inflated) await consume(chunk);
        },
      );
    } catch (err) {
      // An already-classified failure (abort, stall, the sink's own ReadError)
      // propagates unwrapped; a genuine inflate/read failure is a corrupt stream.
      if (err instanceof ZipKitError) throw err;
      throw new ReadError("read.inflate-failed", `cannot inflate ${entry.archivePath}`, {
        cause: err,
      });
    }
  }
  if (uncompressedSize !== entry.uncompSize) {
    throw new ReadError(
      "read.size-mismatch",
      `uncompressed size does not match the declared size for ${entry.archivePath}`,
    );
  }
  return { crc32: crc >>> 0, uncompressedSize };
}

/** An entry's compressed bytes, read from the handle in `chunkSize` pieces. */
async function* compressedChunks(
  file: VolumeFile,
  start: number,
  endExclusive: number,
  chunkSize: number,
): AsyncGenerator<Buffer> {
  let position = start;
  while (position < endExclusive) {
    const length = Math.min(chunkSize, endExclusive - position);
    const buf = Buffer.allocUnsafe(length);
    const bytesRead = await file.read(buf, 0, length, position);
    if (bytesRead === 0) throw new ReadError("read.malformed", "unexpected end of archive");
    position += bytesRead;
    yield bytesRead === length ? buf : buf.subarray(0, bytesRead);
  }
}

/**
 * Read one entry's full decompressed bytes into a buffer. Reserved for small,
 * structural entries — the embedded manifest — where the content must be parsed
 * whole; the extraction path streams instead so it never buffers an entry.
 */
export async function readEntryBuffer(file: VolumeFile, entry: ReadEntry, maxBytes: number): Promise<Buffer> {
  if (entry.uncompSize > maxBytes) {
    throw new ReadError("read.entry-too-large", `${entry.archivePath} exceeds the in-memory size limit`);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  await readEntryData(
    file,
    entry,
    async (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        throw new ReadError("read.entry-too-large", `${entry.archivePath} exceeds the in-memory size limit`);
      }
      chunks.push(chunk);
    },
    65536,
  );
  return Buffer.concat(chunks);
}
