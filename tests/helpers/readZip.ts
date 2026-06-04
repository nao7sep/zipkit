/**
 * A minimal ZIP reader for round-trip tests: parse the central
 * directory and each local entry, inflating stored/deflated data so content and
 * the byte contract can be asserted. Handles the non-Zip64 case fully and
 * reports whether Zip64 end-of-central-directory structures are present.
 */

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

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("bad local header signature");
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const localExtra = buf.subarray(
      localOffset + 30 + localNameLen,
      localOffset + 30 + localNameLen + localExtraLength,
    );
    const dataStart = localOffset + 30 + localNameLen + localExtraLength;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const content = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);

    entries.push({
      name,
      gpFlag,
      method,
      dosTime,
      dosDate,
      crc32,
      compSize,
      uncompSize,
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
