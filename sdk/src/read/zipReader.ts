/**
 * The ZIP reader: parse a container's directory and stream an entry's bytes,
 * all through positioned reads on an open, bounded file handle so the whole archive
 * is never held in memory. It is the substrate beneath verification: this
 * layer turns a file into structured entries and pipes inflated content to a
 * sink; what is done with it is the caller's job.
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
import { ZipKitError } from "../errors.ts";
import type { VolumeFile } from "../internal/volume.ts";

const EOCD_SIG = 0x06054b50;
const EOCD_MIN = 22;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const CENTRAL_DIGITAL_SIG = 0x05054b50;
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
    throw new ZipKitError("archive.malformed", "archive byte range is not safely addressable");
  }
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = await file.read(buf, got, length - got, position + got);
    if (n === 0) throw new ZipKitError("archive.malformed", "unexpected end of archive");
    got += n;
  }
  return buf;
}

function safeNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipKitError("archive.malformed", `${field} exceeds the safe integer range`);
  }
  return Number(value);
}

function safeAdd(left: number, right: number, field: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < 0) {
    throw new ZipKitError("archive.malformed", `${field} exceeds the safe integer range`);
  }
  return sum;
}

// ZIP's legacy name encoding maps the upper byte range to IBM code page 437.
const CP437_HIGH = "\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0";
function decodeName(bytes: Buffer, flags: number, extra: Buffer): string {
  const unicode = findExtra(extra, 0x7075);
  let utf8: Buffer | undefined;
  if (flags & 0x0800) utf8 = bytes;
  else if (unicode && unicode.length >= 5 && unicode[0] === 1 && unicode.readUInt32LE(1) === (zlib.crc32(bytes) >>> 0)) utf8 = unicode.subarray(5);
  if (utf8) {
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(utf8); }
    catch (cause) { throw new ZipKitError("archive.malformed", "Invalid UTF-8 filename", { cause }); }
  }
  return Array.from(bytes, (byte) => byte < 128 ? String.fromCharCode(byte) : CP437_HIGH[byte - 128]).join("");
}

export interface ReadEntry {
  /** Final archive path: forward slashes, relative, no trailing slash. */
  archivePath: string;
  type: "file" | "dir" | "symlink";
  method: number; // 0 store, 8 deflate
  crc32: number;
  compSize: number;
  uncompSize: number;
  /** ZIP64 sizes, distinct from a ZIP64 offset alone. */
  zip64Sizes?: boolean;
  localOffset: number;
  gpFlag: number;
  externalAttr: number;
  dosDate: number;
  dosTime: number;
  /** The central record's extra field, where the timestamp extras live. */
  extra: Buffer;
  /** The name exactly as the central record stores it, for comparing with
   *  the local header's. */
  nameBytes: Buffer;
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
  throw new ZipKitError("archive.not-zip", "end-of-central-directory record not found");
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
  cdSize: number;
  zip64: boolean;
}> {
  let count = tail.readUInt16LE(eocdInTail + 10);
  const cdSize = tail.readUInt32LE(eocdInTail + 12);
  let cdOffset = tail.readUInt32LE(eocdInTail + 16);
  const eocdOffset = tailStart + eocdInTail;
  // Zip64 records can be present even when classic fields still fit. The
  // locator, when present, identifies where the directory actually ends.
  const locInTail = eocdInTail - 20;
  const hasZip64Locator = locInTail >= 0 && tail.readUInt32LE(locInTail) === ZIP64_LOCATOR_SIG;
  if (count !== U16 && cdSize !== U32 && cdOffset !== U32 && !hasZip64Locator) {
    return { count, cdOffset, cdSize, cdEnd: eocdOffset, zip64: false };
  }

  // A sentinel means the real values live in the Zip64 records. The locator sits
  // immediately before the EOCD and points at the Zip64 EOCD.
  if (hasZip64Locator) {
    const z64 = safeNumber(tail.readBigUInt64LE(locInTail + 8), "Zip64 directory offset");
    const locatorOffset = tailStart + locInTail;
    const minimumRecordEnd = safeAdd(z64, 56, "Zip64 end-record range");
    if (z64 >= 0 && minimumRecordEnd <= locatorOffset) {
      const record = await readExact(file, z64, 56);
      if (record.readUInt32LE(0) !== ZIP64_EOCD_SIG) {
        throw new ZipKitError("archive.malformed", "Zip64 end-of-central-directory not found");
      }
      const recordSize = safeNumber(record.readBigUInt64LE(4), "Zip64 end-record length");
      const recordEnd = safeAdd(z64, 12 + recordSize, "Zip64 end-record range");
      if (recordSize < 44 || recordEnd !== locatorOffset) {
        throw new ZipKitError("archive.malformed", "invalid Zip64 end-of-central-directory length");
      }
      count = safeNumber(record.readBigUInt64LE(32), "Zip64 entry count");
      cdOffset = safeNumber(record.readBigUInt64LE(48), "Zip64 central-directory offset");
      return { count, cdOffset, cdSize: safeNumber(record.readBigUInt64LE(40), "Zip64 central-directory size"), cdEnd: z64, zip64: true };
    }
  }
  throw new ZipKitError("archive.malformed", "Zip64 end-of-central-directory not found");
}

async function parseCentral(file: VolumeFile, cdOffset: number, cdSize: number, count: number): Promise<ReadEntry[]> {
  const entries: ReadEntry[] = [];
  // Read ahead for the usual tiny records, without retaining the blocks in
  // returned entries. A maximum-size name plus extra can exceed one block.
  let block: Buffer = Buffer.alloc(0);
  let blockStart = 0;
  const bytes = async (position: number, length: number): Promise<Buffer> => {
    if (position < blockStart || position + length > blockStart + block.length) {
      blockStart = position;
      block = await readExact(file, cdOffset + position, Math.min(Math.max(65536, length), cdSize - position));
    }
    return block.subarray(position - blockStart, position - blockStart + length);
  };
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cdSize) {
      throw new ZipKitError("archive.malformed", `truncated central-directory header at offset ${p}`);
    }
    const cd = await bytes(p, 46);
    if (cd.readUInt32LE(0) !== CENTRAL_SIG) {
      throw new ZipKitError("archive.malformed", `malformed central directory at offset ${p}`);
    }
    const gpFlag = cd.readUInt16LE(8);
    const method = cd.readUInt16LE(10);
    const dosTime = cd.readUInt16LE(12);
    const dosDate = cd.readUInt16LE(14);
    const crc32 = cd.readUInt32LE(16);
    let compSize = cd.readUInt32LE(20);
    let uncompSize = cd.readUInt32LE(24);
    const nameLen = cd.readUInt16LE(28);
    const extraLen = cd.readUInt16LE(30);
    const commentLen = cd.readUInt16LE(32);
    const externalAttr = cd.readUInt32LE(38);
    let localOffset = cd.readUInt32LE(42);
    const recordEnd = p + 46 + nameLen + extraLen + commentLen;
    if (!Number.isSafeInteger(recordEnd) || recordEnd > cdSize) {
      throw new ZipKitError("archive.malformed", `truncated central-directory record at offset ${p}`);
    }
    // Names and extras are at most two u16 lengths. Skip the unused comment,
    // and retain only this record's metadata rather than the whole directory.
    const metadata = Buffer.from(await bytes(p + 46, nameLen + extraLen));
    const extra = metadata.subarray(nameLen);
    const rawName = decodeName(metadata.subarray(0, nameLen), gpFlag, extra);

    const zip64Sizes = compSize === U32 || uncompSize === U32;
    if (zip64Sizes || localOffset === U32) {
      const z = findExtra(extra, 0x0001);
      const required =
        (uncompSize === U32 ? 8 : 0) +
        (compSize === U32 ? 8 : 0) +
        (localOffset === U32 ? 8 : 0);
      if (!z || z.length < required) {
        throw new ZipKitError("archive.malformed", `missing or truncated Zip64 extra for ${rawName}`);
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
      zip64Sizes,
      localOffset,
      gpFlag,
      externalAttr,
      dosDate,
      dosTime,
      extra,
      nameBytes: metadata.subarray(0, nameLen),
    });
    p = recordEnd;
  }
  if (p !== cdSize) {
    // A ZIP may sign its central directory. Only this optional, length-framed
    // record can follow the counted entries; arbitrary trailing bytes cannot.
    if (cdSize - p < 6) {
      throw new ZipKitError("archive.malformed", "truncated central-directory signature");
    }
    const signature = await bytes(p, 6);
    if (signature.readUInt32LE(0) !== CENTRAL_DIGITAL_SIG || p + 6 + signature.readUInt16LE(4) !== cdSize) {
      throw new ZipKitError("archive.malformed", "central-directory count does not account for its declared size");
    }
  }
  return entries;
}

/**
 * Parse a ZIP's directory from an open file: positioned-read the archive tail to
 * find the EOCD (and any Zip64 records), then decode one central record at a
 * time. Only the names and extras needed for verification are retained.
 */
export async function parseZip(file: VolumeFile, fileSize: number): Promise<ParsedZip> {
  if (fileSize < EOCD_MIN) throw new ZipKitError("archive.not-zip", "file is too small to be a ZIP");
  const tailLen = Math.min(fileSize, MAX_EOCD_SEARCH);
  const tailStart = fileSize - tailLen;
  const tail = await readExact(file, tailStart, tailLen);
  const eocdInTail = findEocdInTail(tail);
  const { count, cdOffset, cdSize, cdEnd, zip64 } = await locateCentralDir(
    file,
    tail,
    tailStart,
    eocdInTail,
  );

  // Check the declared geometry before reading any directory records. In
  // particular, an empty directory cannot claim an arbitrary payload region.
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Number.isSafeInteger(cdOffset) ||
    cdOffset < 0 ||
    !Number.isSafeInteger(cdSize) ||
    cdSize < 0 ||
    safeAdd(cdOffset, cdSize, "central-directory range") !== cdEnd ||
    count > Math.floor(cdSize / 46) ||
    cdEnd > fileSize
  ) {
    throw new ZipKitError("archive.malformed", "central directory location is out of range");
  }
  return { entries: await parseCentral(file, cdOffset, cdSize, count), zip64 };
}

/** The byte offset of an entry's data, after its local header, name, and extra. */
async function entryDataOffset(file: VolumeFile, entry: ReadEntry): Promise<number> {
  const header = await readExact(file, entry.localOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_SIG) {
    throw new ZipKitError("archive.malformed", `bad local header for ${entry.archivePath}`);
  }
  const nameLen = header.readUInt16LE(26);
  const extraLen = header.readUInt16LE(28);
  return safeAdd(entry.localOffset, 30 + nameLen + extraLen, `data offset for ${entry.archivePath}`);
}

const GP_UTF8 = 0x0800;
const GP_DATA_DESCRIPTOR = 0x0008;

/**
 * How an entry's local header disagrees with its central record, or null when
 * they agree. A reader that walks the local headers (macOS Archive Utility,
 * many streaming extractors) trusts them rather than the central directory,
 * so an archive whose two copies differ opens differently, or not at all,
 * depending on the tool. Compared: the name's bytes, the UTF-8 flag, the
 * method, and the CRC-32 and sizes unless the entry defers them to a data
 * descriptor.
 */
export async function localHeaderMismatch(file: VolumeFile, entry: ReadEntry): Promise<string | null> {
  const header = await readExact(file, entry.localOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_SIG) return "no local header at the recorded offset";
  const flags = header.readUInt16LE(6);
  const nameLen = header.readUInt16LE(26);
  const extraLen = header.readUInt16LE(28);
  const rest = await readExact(file, entry.localOffset + 30, nameLen + extraLen);
  if (!rest.subarray(0, nameLen).equals(entry.nameBytes)) return "name differs";
  if ((flags & GP_UTF8) !== (entry.gpFlag & GP_UTF8)) return "UTF-8 flag differs";
  if (header.readUInt16LE(8) !== entry.method) return "compression method differs";
  if ((flags & GP_DATA_DESCRIPTOR) !== (entry.gpFlag & GP_DATA_DESCRIPTOR)) return "data descriptor flag differs";
  if (flags & GP_DATA_DESCRIPTOR) {
    const wide = findExtra(rest.subarray(nameLen), 0x0001) !== null || entry.zip64Sizes === true;
    const offset = safeAdd(entry.localOffset + 30 + nameLen + extraLen, entry.compSize, "data descriptor offset");
    const length = wide ? 20 : 12;
    let bytes = await readExact(file, offset, length);
    const matches = (data: Buffer): boolean => data.readUInt32LE(0) === (entry.crc32 >>> 0) &&
      (wide ? data.readBigUInt64LE(4) === BigInt(entry.compSize) && data.readBigUInt64LE(12) === BigInt(entry.uncompSize)
        : data.readUInt32LE(4) === entry.compSize && data.readUInt32LE(8) === entry.uncompSize);
    // A CRC can equal the optional signature; try the unsigned form first.
    if (matches(bytes)) return null;
    if (bytes.readUInt32LE(0) === 0x08074b50) bytes = await readExact(file, offset + 4, length);
    return matches(bytes) ? null : "data descriptor differs";
  }
  if ((header.readUInt32LE(14) >>> 0) !== (entry.crc32 >>> 0)) return "CRC-32 differs";
  let compSize = header.readUInt32LE(18);
  let uncompSize = header.readUInt32LE(22);
  if (compSize === U32 || uncompSize === U32) {
    // The local Zip64 extra holds both sizes, uncompressed first.
    const z = findExtra(rest.subarray(nameLen), 0x0001);
    if (!z || z.length < 16) return "Zip64 sizes missing";
    uncompSize = safeNumber(z.readBigUInt64LE(0), `local uncompressed size for ${entry.archivePath}`);
    compSize = safeNumber(z.readBigUInt64LE(8), `local compressed size for ${entry.archivePath}`);
  }
  if (compSize !== entry.compSize || uncompSize !== entry.uncompSize) return "sizes differ";
  return null;
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
 * directory with no payload yields nothing; declared directory payloads are
 * checked just like file payloads.
 */
export async function readEntryData(
  file: VolumeFile,
  entry: ReadEntry,
  sink: DataSink,
  chunkSize: number,
): Promise<EntryReadResult> {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipKitError(
      "archive.unsupported-method",
      `unsupported compression method ${entry.method} for ${entry.archivePath}`,
    );
  }
  // A zero-length entry (an empty file, or a deflate stream with no payload) has
  // no compressed bytes to read; a read stream with `end < start` is invalid, so
  // short-circuit. CRC-32 over no bytes is 0, which matches the stored value.
  if (entry.compSize === 0) {
    if (entry.uncompSize !== 0) {
      throw new ZipKitError(
        "archive.size-mismatch",
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
      throw new ZipKitError(
        "archive.size-mismatch",
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
    const externalErrors = new Set<unknown>();
    async function* input(): AsyncGenerator<Buffer> {
      try { yield* source; }
      catch (error) { externalErrors.add(error); throw error; }
    }
    try {
      await pipeline(
        Readable.from(input()),
        zlib.createInflateRaw({ chunkSize }),
        async (inflated: AsyncIterable<Buffer>) => {
          for await (const chunk of inflated) {
            try { await consume(chunk); }
            catch (error) { externalErrors.add(error); throw error; }
          }
        },
      );
    } catch (err) {
      // Only zlib's own data errors describe corrupt content. Disk and sink
      // failures retain their original identity for the operation boundary.
      if (externalErrors.has(err) || err instanceof ZipKitError ||
          !["Z_DATA_ERROR", "Z_BUF_ERROR"].includes((err as NodeJS.ErrnoException)?.code ?? "")) throw err;
      throw new ZipKitError("archive.corrupt-data", `cannot inflate ${entry.archivePath}`, {
        cause: err,
      });
    }
  }
  if (uncompressedSize !== entry.uncompSize) {
    throw new ZipKitError(
      "archive.size-mismatch",
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
    if (bytesRead === 0) throw new ZipKitError("archive.malformed", "unexpected end of archive");
    position += bytesRead;
    yield bytesRead === length ? buf : buf.subarray(0, bytesRead);
  }
}
