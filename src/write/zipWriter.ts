/**
 * The in-house ZIP container framing — local file headers, the central
 * directory, the end-of-central-directory record, and Zip64 structures — driven
 * as a streaming writer. The archive is one ordered byte stream, so entries are
 * written sequentially through a single seekable file descriptor: a temp file
 * in the output's directory, fsync'd and atomically renamed into place. The
 * clean-byte contract is encoded here:
 *
 * - The general-purpose flag has bit 11 set (names are UTF-8).
 * - Version-made-by uses host byte 0 (FAT), so no Unix mode leaks; external
 *   attributes carry only the DOS attribute byte (`0x10` for a directory).
 * - The extra-field length is zero except the Zip64 extra (`0x0001`) when
 *   genuinely needed and, only under timestamp preservation, the Info-ZIP
 *   extended-timestamp extra (`0x5455`, UTC seconds) and the NTFS extra
 *   (`0x000a`, UTC 100-ns FILETIME). Both carry modification, access, and
 *   creation times so a reader on any platform recovers the right instant.
 * - The DOS date/time field holds *local* wall-clock time, rendered in the
 *   configured timezone (the host zone by default), clamped to the 1980–2107
 *   window. DOS time carries no zone, so it is only a same-zone convenience —
 *   the absolute truth lives in the two UTC extras above and in the metadata
 *   record.
 * - The path separator is always a forward slash.
 *
 * The single deliberate exception is a preserved symlink: it carries a Unix
 * host byte and link mode, because there is no other faithful representation.
 *
 * CRC-32 and the compressed size are not known until an entry has streamed, but
 * the uncompressed size (from `stat`) and therefore the Zip64 decision are known
 * up front, so the header FORMAT is fixed before the header is written. The
 * local header is written with placeholder crc/size fields, the data is
 * streamed, then the real values are patched back into the header at its
 * recorded offset with positioned writes — no data descriptors, no GP bit 3, so
 * the bytes match what a same-archive reader and `unzip` expect.
 */

import { close, fsync, open, rename, write as fsWrite } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { wallClockInZone } from "../internal/timeZone.js";
import { EntryCompressor, type ChunkSink } from "./deflate.js";

const openAsync = promisify(open);
const closeAsync = promisify(close);
const fsyncAsync = promisify(fsync);
const renameAsync = promisify(rename);

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

const U16 = 0xffff;
const U32 = 0xffffffff;
const GP_UTF8 = 0x0800;

const EMPTY = Buffer.alloc(0);

// 1980-01-01T00:00:00, the DOS epoch; used as the floor and the fixed time.
const FIXED_DOS = { date: (1 << 5) | 1, time: 0 };
// 2107-12-31T23:59:58, the latest time the DOS field can represent (ceiling).
const MAX_DOS = { date: ((2107 - 1980) << 9) | (12 << 5) | 31, time: (23 << 11) | (59 << 5) | 29 };

const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

// The widest instant JS `Date` can represent (±100,000,000 days from the epoch).
// An instant beyond this cannot be rendered, so it is clamped by sign.
const DATE_MS_LIMIT = 8_640_000_000_000_000;

/**
 * One entry to write. A `file`/`symlink` streams its bytes through the writer;
 * a `dir` carries none. The crc/compressed-size are produced by the stream and
 * are not part of this input.
 */
export interface WriteEntryInput {
  name: string; // archive path, no trailing slash; the writer adds it for dirs
  type: "file" | "dir" | "symlink";
  method: "store" | "deflate";
  uncompressedSize: number; // known from stat up front; fixes the header format
  mtimeNs: bigint;
  atimeNs: bigint;
  birthtimeNs: bigint; // creation time; the NTFS/UT "creation" field
  mode: number; // used only for a preserved symlink's external attributes
}

export interface ZipWriterOptions {
  /** Force Zip64 structures (the policy's `always`, or an auto-detected need). */
  zip64: boolean;
  preserveTimestamps: boolean;
  /** IANA zone the DOS local-time field is rendered in (already resolved). */
  timeZone: string;
  /** highWaterMark for the temp-file writes and the deflate stream. */
  chunkSize: number;
}

/** The result an entry's data source must produce when fully consumed. */
export interface StreamResult {
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
}

/** The per-entry geometry recorded when its local header is written, needed to
 *  stream its data, patch the header, and build the central record. */
interface EntryGeometry {
  nameBuf: Buffer;
  date: number;
  time: number;
  useZip64: boolean;
  headerOffset: number;
  times: { local: Buffer; central: Buffer } | null;
  info: { madeBy: number; extAttr: number; baseVersion: number };
  versionNeeded: number;
}

function dosFor(entry: WriteEntryInput, options: ZipWriterOptions): { date: number; time: number } {
  const ms = Number(entry.mtimeNs / 1_000_000n);
  if (!Number.isFinite(ms) || ms < -DATE_MS_LIMIT) return FIXED_DOS;
  if (ms > DATE_MS_LIMIT) return MAX_DOS;
  // The DOS field is local wall-clock with no zone stored: render the instant in
  // the configured zone so a same-zone reader sees the file's real time. Clamp
  // on the *local* components, not the UTC instant — a zone offset can carry an
  // instant that is within the UTC window just past the 1980/2107 edges, which
  // would otherwise overflow the packed 16-bit fields.
  const w = wallClockInZone(ms, options.timeZone);
  if (w.year < 1980) return FIXED_DOS;
  if (w.year > 2107) return MAX_DOS;
  return {
    date: ((w.year - 1980) << 9) | (w.month << 5) | w.day,
    time: (w.hour << 11) | (w.minute << 5) | (w.second >> 1),
  };
}

// 100-ns ticks between the FILETIME epoch (1601) and the Unix epoch (1970).
const NTFS_EPOCH_OFFSET = 116_444_736_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;

/** Unix seconds floored toward negative infinity (bigint division truncates). */
function unixSecondsFloor(ns: bigint): bigint {
  const quotient = ns / 1_000_000_000n;
  return ns % 1_000_000_000n < 0n ? quotient - 1n : quotient;
}

/** A time as signed 32-bit Unix seconds, or null when outside the UT field. */
function utSeconds(ns: bigint): number | null {
  const seconds = unixSecondsFloor(ns);
  if (seconds < BigInt(INT32_MIN) || seconds > BigInt(INT32_MAX)) return null;
  return Number(seconds);
}

/** A time as a Windows FILETIME (100-ns ticks since 1601 UTC), clamped to u64. */
function filetime(ns: bigint): bigint {
  const ticks = ns / 100n + NTFS_EPOCH_OFFSET;
  return ticks < 0n ? 0n : ticks > U64_MAX ? U64_MAX : ticks;
}

/**
 * The Info-ZIP extended-timestamp extra (0x5455), carrying modification,
 * access, and creation times as UTC seconds. The local-header copy holds every
 * time whose seconds fit the field's signed 32-bit range (roughly 1901–2038);
 * the central copy holds only the modification time per the field's convention,
 * sharing the same flags byte. Returns null when no time is representable, so a
 * value is never silently misrepresented — the metadata file stays lossless.
 */
function extendedTimestamp(entry: WriteEntryInput): { local: Buffer; central: Buffer } | null {
  const m = utSeconds(entry.mtimeNs);
  const a = utSeconds(entry.atimeNs);
  // A birthtime of 0 is the platform's "creation time unavailable" marker
  // (Node may also report ctime there, which is indistinguishable); do not
  // assert a creation time we were not actually given.
  const c = entry.birthtimeNs > 0n ? utSeconds(entry.birthtimeNs) : null;
  const flags = (m !== null ? 1 : 0) | (a !== null ? 2 : 0) | (c !== null ? 4 : 0);
  if (flags === 0) return null;

  const present = [m, a, c].filter((v): v is number => v !== null);
  const local = Buffer.alloc(5 + present.length * 4);
  local.writeUInt16LE(0x5455, 0); // "UT"
  local.writeUInt16LE(1 + present.length * 4, 2);
  local.writeUInt8(flags, 4);
  present.forEach((v, i) => local.writeInt32LE(v, 5 + i * 4));

  const central = Buffer.alloc(m !== null ? 9 : 5);
  central.writeUInt16LE(0x5455, 0);
  central.writeUInt16LE(m !== null ? 5 : 1, 2);
  central.writeUInt8(flags, 4);
  if (m !== null) central.writeInt32LE(m, 5);

  return { local, central };
}

/**
 * The NTFS extra (0x000a): modification, access, and creation times as 64-bit
 * Windows FILETIME, identical in the local and central records. Windows Explorer
 * prefers this field, so it is what restores full-precision, zone-correct times
 * there. Unlike the DOS field it represents the full Unix range, so it is always
 * written under preservation.
 */
function ntfsTimestamp(entry: WriteEntryInput): Buffer {
  const b = Buffer.alloc(36);
  b.writeUInt16LE(0x000a, 0); // tag
  b.writeUInt16LE(32, 2); // TSize: reserved(4) + attr header(4) + three 8-byte times
  b.writeUInt32LE(0, 4); // reserved
  b.writeUInt16LE(0x0001, 8); // attribute tag 1
  b.writeUInt16LE(24, 10); // attribute size
  b.writeBigUInt64LE(filetime(entry.mtimeNs), 12);
  b.writeBigUInt64LE(filetime(entry.atimeNs), 20);
  // 0 = FILETIME "unset" (1601), written when no real creation time is known,
  // rather than fabricating one from the platform's fallback value.
  b.writeBigUInt64LE(entry.birthtimeNs > 0n ? filetime(entry.birthtimeNs) : 0n, 28);
  return b;
}

/** The combined timestamp extras (UT + NTFS) for the local and central records. */
function timestampExtras(entry: WriteEntryInput): { local: Buffer; central: Buffer } {
  const ut = extendedTimestamp(entry);
  const ntfs = ntfsTimestamp(entry);
  return {
    local: ut ? Buffer.concat([ut.local, ntfs]) : ntfs,
    central: ut ? Buffer.concat([ut.central, ntfs]) : ntfs,
  };
}

function zip64LocalExtra(uncompressed: number, compressed: number): Buffer {
  const b = Buffer.alloc(20);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(16, 2);
  b.writeBigUInt64LE(BigInt(uncompressed), 4);
  b.writeBigUInt64LE(BigInt(compressed), 12);
  return b;
}

function zip64CentralExtra(uncompressed: number, compressed: number, offset: number): Buffer {
  const b = Buffer.alloc(28);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(24, 2);
  b.writeBigUInt64LE(BigInt(uncompressed), 4);
  b.writeBigUInt64LE(BigInt(compressed), 12);
  b.writeBigUInt64LE(BigInt(offset), 20);
  return b;
}

function hostInfo(entry: WriteEntryInput): { madeBy: number; extAttr: number; baseVersion: number } {
  if (entry.type === "symlink") {
    const mode = (entry.mode & 0xffff) || 0o120777;
    return { madeBy: (3 << 8) | 20, extAttr: (mode * 0x10000) >>> 0, baseVersion: 20 };
  }
  const baseVersion = entry.method === "deflate" ? 20 : 10;
  if (entry.type === "dir") return { madeBy: 20, extAttr: 0x10, baseVersion };
  return { madeBy: 20, extAttr: 0, baseVersion };
}

function localHeader(p: {
  versionNeeded: number;
  method: WriteEntryInput["method"];
  date: number;
  time: number;
  crc32: number;
  compSize: number;
  uncompSize: number;
  nameLen: number;
  extraLen: number;
}): Buffer {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(LOCAL_SIG, 0);
  b.writeUInt16LE(p.versionNeeded, 4);
  b.writeUInt16LE(GP_UTF8, 6);
  b.writeUInt16LE(p.method === "deflate" ? 8 : 0, 8);
  b.writeUInt16LE(p.time, 10);
  b.writeUInt16LE(p.date, 12);
  b.writeUInt32LE(p.crc32 >>> 0, 14);
  b.writeUInt32LE(p.compSize >>> 0, 18);
  b.writeUInt32LE(p.uncompSize >>> 0, 22);
  b.writeUInt16LE(p.nameLen, 26);
  b.writeUInt16LE(p.extraLen, 28);
  return b;
}

function centralRecord(p: {
  madeBy: number;
  versionNeeded: number;
  method: WriteEntryInput["method"];
  date: number;
  time: number;
  crc32: number;
  compSize: number;
  uncompSize: number;
  nameLen: number;
  extraLen: number;
  extAttr: number;
  offset: number;
}): Buffer {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(CENTRAL_SIG, 0);
  b.writeUInt16LE(p.madeBy, 4);
  b.writeUInt16LE(p.versionNeeded, 6);
  b.writeUInt16LE(GP_UTF8, 8);
  b.writeUInt16LE(p.method === "deflate" ? 8 : 0, 10);
  b.writeUInt16LE(p.time, 12);
  b.writeUInt16LE(p.date, 14);
  b.writeUInt32LE(p.crc32 >>> 0, 16);
  b.writeUInt32LE(p.compSize >>> 0, 20);
  b.writeUInt32LE(p.uncompSize >>> 0, 24);
  b.writeUInt16LE(p.nameLen, 28);
  b.writeUInt16LE(p.extraLen, 30);
  b.writeUInt16LE(0, 32); // file comment length
  b.writeUInt16LE(0, 34); // disk number start
  b.writeUInt16LE(0, 36); // internal attributes
  b.writeUInt32LE(p.extAttr >>> 0, 38);
  b.writeUInt32LE(p.offset >>> 0, 42);
  return b;
}

const writeFd = promisify(
  (fd: number, buffer: Buffer, offset: number, length: number, position: number | null,
   cb: (err: NodeJS.ErrnoException | null) => void) =>
    fsWrite(fd, buffer, offset, length, position, (err) => cb(err)),
);

/**
 * A streaming ZIP writer. Open it on an output path, append entries in order —
 * each `file`/`symlink` streams its bytes through `streamEntry`, a `dir` through
 * `addDir` — then `finalize` to write the central directory and EOCD, fsync, and
 * atomically rename the temp file into place. Sequential by construction: the
 * archive is one ordered byte stream.
 */
export class ZipWriter {
  readonly #output: string;
  readonly #tempPath: string;
  readonly #options: ZipWriterOptions;
  #fd = -1;
  /** Append position in the temp file (also each entry's local-header offset). */
  #offset = 0;
  readonly #central: Buffer[] = [];
  #count = 0;
  #anyEntryZip64 = false;

  constructor(output: string, options: ZipWriterOptions) {
    this.#output = output;
    this.#options = options;
    // A temp file in the output's own directory, so the closing rename is a
    // same-filesystem atomic replace — the same atomic guarantee, kept without
    // buffering the whole archive in memory.
    this.#tempPath = join(dirname(output), `.${process.pid}-${Date.now()}.zip.tmp`);
  }

  async open(): Promise<void> {
    this.#fd = await openAsync(this.#tempPath, "w");
  }

  /** Append raw bytes at the current offset, advancing it. */
  async #append(buffer: Buffer): Promise<void> {
    if (buffer.length === 0) return;
    await writeFd(this.#fd, buffer, 0, buffer.length, this.#offset);
    this.#offset += buffer.length;
  }

  /**
   * Decide the header format and write the local header + name + extra, leaving
   * the crc/sizes as placeholders. Returns the per-entry geometry the caller
   * needs to stream the data and patch the header afterward.
   */
  #beginEntry(entry: WriteEntryInput): EntryGeometry {
    const name = entry.type === "dir" ? `${entry.name}/` : entry.name;
    const nameBuf = Buffer.from(name, "utf8");
    const { date, time } = dosFor(entry, this.#options);
    const headerOffset = this.#offset;
    // The uncompressed size and offset are known now; the compressed size can
    // only shrink, so an entry that does not need Zip64 by uncompressed size or
    // offset never needs it by compressed size. The format is therefore fixed.
    const useZip64 = entry.uncompressedSize >= U32 || headerOffset >= U32;
    if (useZip64) this.#anyEntryZip64 = true;
    const info = hostInfo(entry);
    const versionNeeded = useZip64 ? 45 : info.baseVersion;
    const times = this.#options.preserveTimestamps ? timestampExtras(entry) : null;
    return { nameBuf, date, time, useZip64, headerOffset, times, info, versionNeeded };
  }

  /** Build the local extra blob for an entry's chosen format. */
  #localExtra(
    useZip64: boolean,
    uncompSize: number,
    compSize: number,
    times: { local: Buffer } | null,
  ): Buffer {
    const parts: Buffer[] = [];
    if (useZip64) parts.push(zip64LocalExtra(uncompSize, compSize));
    if (times) parts.push(times.local);
    return parts.length > 0 ? Buffer.concat(parts) : EMPTY;
  }

  /** Record the central-directory entry once the stream's crc/sizes are known. */
  #pushCentral(
    entry: WriteEntryInput,
    g: EntryGeometry,
    result: StreamResult,
  ): void {
    const centralExtra: Buffer[] = [];
    if (g.useZip64) {
      centralExtra.push(
        zip64CentralExtra(result.uncompressedSize, result.compressedSize, g.headerOffset),
      );
    }
    if (g.times) centralExtra.push(g.times.central);
    const centralExtraBuf = centralExtra.length > 0 ? Buffer.concat(centralExtra) : EMPTY;

    this.#central.push(
      centralRecord({
        madeBy: g.info.madeBy,
        versionNeeded: g.versionNeeded,
        method: entry.method,
        date: g.date,
        time: g.time,
        crc32: result.crc32,
        compSize: g.useZip64 ? U32 : result.compressedSize,
        uncompSize: g.useZip64 ? U32 : result.uncompressedSize,
        nameLen: g.nameBuf.length,
        extraLen: centralExtraBuf.length,
        extAttr: g.info.extAttr,
        offset: g.useZip64 ? U32 : g.headerOffset,
      }),
      g.nameBuf,
      centralExtraBuf,
    );
    this.#count++;
  }

  /**
   * Patch the real crc/sizes into a local header at its recorded offset. The
   * header's crc field is at +14, the compressed size at +18, the uncompressed
   * size at +22. Under Zip64 the base fields stay the sentinel and the real
   * 64-bit sizes live in the local Zip64 extra (which follows the name).
   */
  async #patchLocalHeader(
    g: EntryGeometry,
    result: StreamResult,
  ): Promise<void> {
    const patch = Buffer.alloc(12);
    patch.writeUInt32LE(result.crc32 >>> 0, 0);
    patch.writeUInt32LE(g.useZip64 ? U32 : result.compressedSize, 4);
    patch.writeUInt32LE(g.useZip64 ? U32 : result.uncompressedSize, 8);
    await writeFd(this.#fd, patch, 0, patch.length, g.headerOffset + 14);

    if (g.useZip64) {
      // The Zip64 local extra sits right after the name; overwrite its two
      // 8-byte size fields (which were written with the placeholder sizes).
      const sizes = Buffer.alloc(16);
      sizes.writeBigUInt64LE(BigInt(result.uncompressedSize), 0);
      sizes.writeBigUInt64LE(BigInt(result.compressedSize), 8);
      // local header(30) + name + extra-id(2) + extra-size(2) = start of values.
      const valuesOffset = g.headerOffset + 30 + g.nameBuf.length + 4;
      await writeFd(this.#fd, sizes, 0, sizes.length, valuesOffset);
    }
  }

  /**
   * Stream one file/symlink entry. `produce` is called with a sink that the
   * caller pushes the entry's compressed/stored bytes into (typically by piping
   * a read stream through an {@link EntryCompressor}); it returns the final crc
   * and sizes. The header is written first (placeholders), then the data via the
   * sink, then the header is patched.
   */
  async streamEntry(
    entry: WriteEntryInput,
    produce: (sink: ChunkSink) => Promise<StreamResult>,
  ): Promise<StreamResult> {
    const g = this.#beginEntry(entry);
    // Placeholder local extra uses the entry's known uncompressed size and a
    // zero compressed size; the patch step rewrites both to the real values.
    const localExtra = this.#localExtra(g.useZip64, entry.uncompressedSize, 0, g.times);
    await this.#append(
      localHeader({
        versionNeeded: g.versionNeeded,
        method: entry.method,
        date: g.date,
        time: g.time,
        crc32: 0,
        compSize: g.useZip64 ? U32 : 0,
        uncompSize: g.useZip64 ? U32 : entry.uncompressedSize,
        nameLen: g.nameBuf.length,
        extraLen: localExtra.length,
      }),
    );
    await this.#append(g.nameBuf);
    await this.#append(localExtra);

    const result = await produce((chunk) => this.#append(chunk));
    await this.#patchLocalHeader(g, result);
    this.#pushCentral(entry, g, result);
    return result;
  }

  /** Append a directory entry (no data; trailing slash and 0x10 attribute). */
  async addDir(entry: WriteEntryInput): Promise<void> {
    const g = this.#beginEntry(entry);
    const localExtra = this.#localExtra(g.useZip64, 0, 0, g.times);
    await this.#append(
      localHeader({
        versionNeeded: g.versionNeeded,
        method: "store",
        date: g.date,
        time: g.time,
        crc32: 0,
        compSize: g.useZip64 ? U32 : 0,
        uncompSize: g.useZip64 ? U32 : 0,
        nameLen: g.nameBuf.length,
        extraLen: localExtra.length,
      }),
    );
    await this.#append(g.nameBuf);
    await this.#append(localExtra);
    this.#pushCentral(entry, g, { crc32: 0, compressedSize: 0, uncompressedSize: 0 });
  }

  /**
   * Write the central directory and EOCD (with Zip64 records when needed),
   * fsync, close, and atomically rename the temp file into place. Returns
   * whether Zip64 structures were emitted and the final byte length. An optional
   * archive comment is written into the EOCD comment field (UTF-8).
   */
  async finalize(forceZip64: boolean, comment?: string): Promise<{ zip64: boolean; bytes: number }> {
    const cdStart = this.#offset;
    for (const record of this.#central) await this.#append(record);
    const cdSize = this.#offset - cdStart;
    const count = this.#count;

    const needZip64 =
      forceZip64 || this.#anyEntryZip64 || count >= U16 || cdStart >= U32 || cdSize >= U32;

    if (needZip64) {
      const eocd64 = Buffer.alloc(56);
      eocd64.writeUInt32LE(ZIP64_EOCD_SIG, 0);
      eocd64.writeBigUInt64LE(44n, 4); // size of this record minus 12
      eocd64.writeUInt16LE(45, 12); // version made by (FAT host, 4.5)
      eocd64.writeUInt16LE(45, 14); // version needed
      eocd64.writeUInt32LE(0, 16); // this disk
      eocd64.writeUInt32LE(0, 20); // disk with central directory
      eocd64.writeBigUInt64LE(BigInt(count), 24);
      eocd64.writeBigUInt64LE(BigInt(count), 32);
      eocd64.writeBigUInt64LE(BigInt(cdSize), 40);
      eocd64.writeBigUInt64LE(BigInt(cdStart), 48);
      await this.#append(eocd64);

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(ZIP64_LOCATOR_SIG, 0);
      locator.writeUInt32LE(0, 4); // disk with the zip64 end record
      locator.writeBigUInt64LE(BigInt(cdStart + cdSize), 8);
      locator.writeUInt32LE(1, 16); // total number of disks
      await this.#append(locator);
    }

    // The EOCD comment field length is 16-bit; a longer comment is rejected at
    // the spec boundary, so truncation here would be a bug, not a fallback.
    const commentBuf =
      comment !== undefined && comment.length > 0 ? Buffer.from(comment, "utf8") : EMPTY;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4); // this disk
    eocd.writeUInt16LE(0, 6); // disk with central directory
    eocd.writeUInt16LE(count >= U16 ? U16 : count, 8);
    eocd.writeUInt16LE(count >= U16 ? U16 : count, 10);
    eocd.writeUInt32LE(cdSize >= U32 ? U32 : cdSize, 12);
    eocd.writeUInt32LE(cdStart >= U32 ? U32 : cdStart, 16);
    eocd.writeUInt16LE(commentBuf.length, 20); // comment length
    await this.#append(eocd);
    await this.#append(commentBuf);

    const bytes = this.#offset;
    await fsyncAsync(this.#fd);
    await closeAsync(this.#fd);
    this.#fd = -1;
    await renameAsync(this.#tempPath, this.#output);
    return { zip64: needZip64, bytes };
  }

  /** Close and remove the temp file after a failed write, best-effort. */
  async abort(): Promise<void> {
    if (this.#fd >= 0) {
      try {
        await closeAsync(this.#fd);
      } catch {
        /* the fd may already be closed */
      }
      this.#fd = -1;
    }
    try {
      const { rm } = await import("node:fs/promises");
      await rm(this.#tempPath, { force: true });
    } catch {
      /* the temp file may not exist */
    }
  }
}

export { EntryCompressor };
export type { ChunkSink };
