/**
 * A minimal ZIP reader for round-trip tests: parse the central
 * directory and each local entry, inflating stored/deflated data so content and
 * the byte contract can be asserted. Resolves a per-entry Zip64 record — when a
 * 32-bit size or offset field holds the sentinel, the real value is read from the
 * `0x0001` extra (in its fixed order) — and reports whether the Zip64
 * end-of-central-directory structures are present.
 */

import { readFileSync } from "node:fs";
import zlib from "node:zlib";

export interface ReadEntry {
  name: string;
  gpFlag: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc32: number;
  compSize: number;
  uncompSize: number;
  versionMadeBy: number;
  hostByte: number;
  externalAttr: number;
  centralExtraLength: number;
  localExtraLength: number;
  centralExtra: Buffer;
  localExtra: Buffer;
  content: Buffer;
}

/** Locate an extra field by its 2-byte header id within an extra-field blob. */
export function findExtra(extra: Buffer, id: number): Buffer | null {
  let p = 0;
  while (p + 4 <= extra.length) {
    const tag = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (tag === id) return extra.subarray(p + 4, p + 4 + size);
    p += 4 + size;
  }
  return null;
}

export interface ReadZip {
  entries: ReadEntry[];
  hasZip64Eocd: boolean;
  hasZip64Locator: boolean;
}

function findEocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("EOCD not found");
}

export function readZip(buf: Buffer): ReadZip {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const hasZip64Eocd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])) >= 0;
  const hasZip64Locator = buf.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07])) >= 0;

  const entries: ReadEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory signature");
    const versionMadeBy = buf.readUInt16LE(p + 4);
    const gpFlag = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const dosTime = buf.readUInt16LE(p + 12);
    const dosDate = buf.readUInt16LE(p + 14);
    const crc32 = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const centralExtraLength = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttr = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const centralExtra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + centralExtraLength);

    // Resolve Zip64: a sentinel 32-bit field means the real value lives in the
    // `0x0001` extra, in the fixed order uncompressed, compressed, offset.
    let realUncompSize = uncompSize;
    let realCompSize = compSize;
    let realOffset = localOffset;
    const z64 = findExtra(centralExtra, 0x0001);
    if (z64) {
      let o = 0;
      if (uncompSize === 0xffffffff) { realUncompSize = Number(z64.readBigUInt64LE(o)); o += 8; }
      if (compSize === 0xffffffff) { realCompSize = Number(z64.readBigUInt64LE(o)); o += 8; }
      if (localOffset === 0xffffffff) { realOffset = Number(z64.readBigUInt64LE(o)); o += 8; }
    }

    if (buf.readUInt32LE(realOffset) !== 0x04034b50) throw new Error("bad local header signature");
    const localNameLen = buf.readUInt16LE(realOffset + 26);
    const localExtraLength = buf.readUInt16LE(realOffset + 28);
    const localExtra = buf.subarray(
      realOffset + 30 + localNameLen,
      realOffset + 30 + localNameLen + localExtraLength,
    );
    const dataStart = realOffset + 30 + localNameLen + localExtraLength;
    const raw = buf.subarray(dataStart, dataStart + realCompSize);
    const content = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);

    entries.push({
      name,
      gpFlag,
      method,
      dosTime,
      dosDate,
      crc32,
      compSize: realCompSize,
      uncompSize: realUncompSize,
      versionMadeBy,
      hostByte: (versionMadeBy >> 8) & 0xff,
      externalAttr,
      centralExtraLength,
      localExtraLength,
      centralExtra,
      localExtra,
      content,
    });

    p += 46 + nameLen + centralExtraLength + commentLen;
  }

  return { entries, hasZip64Eocd, hasZip64Locator };
}

/** Read an archive from disk and parse it — the streaming writer's output lands
 *  in a file, so tests assert the byte contract by reading the file back. */
export function readZipFile(path: string): ReadZip {
  return readZip(readFileSync(path));
}
