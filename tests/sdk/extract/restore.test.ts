/**
 * Unit tests for timestamp-restore source selection (NTFS → Info-ZIP UT → DOS
 * field). The end-to-end extract tests only ever read archives the writer
 * produced, which always carry the NTFS extra — so the UT-only and DOS-only
 * fallbacks, and the zone-aware DOS decoding (the path that runs when extracting
 * a third-party ZIP), are exercised here against hand-built byte layouts.
 */

import { describe, expect, it } from "vitest";
import { restoreTimes } from "../../../src/sdk/extract/restore.js";
import type { ReadEntry } from "../../../src/sdk/extract/zipReader.js";

const NTFS_EPOCH_OFFSET = 116_444_736_000_000_000n;
const filetime = (ms: number): bigint => BigInt(ms) * 10_000n + NTFS_EPOCH_OFFSET;

/** A full NTFS (0x000a) extra field carrying mtime/atime/ctime as FILETIME. */
function ntfsExtra(mtimeMs: number, atimeMs: number, ctimeMs = 0): Buffer {
  const value = Buffer.alloc(32);
  value.writeUInt16LE(0x0001, 4); // attribute tag 1
  value.writeUInt16LE(24, 6); // attribute size
  value.writeBigUInt64LE(filetime(mtimeMs), 8);
  value.writeBigUInt64LE(filetime(atimeMs), 16);
  value.writeBigUInt64LE(filetime(ctimeMs), 24);
  const field = Buffer.alloc(4 + value.length);
  field.writeUInt16LE(0x000a, 0);
  field.writeUInt16LE(value.length, 2);
  value.copy(field, 4);
  return field;
}

/** A central-record Info-ZIP extended-timestamp (0x5455) carrying the mod time. */
function utExtra(mtimeSec: number): Buffer {
  const field = Buffer.alloc(4 + 5);
  field.writeUInt16LE(0x5455, 0);
  field.writeUInt16LE(5, 2);
  field.writeUInt8(0x01, 4); // flags: modification time present
  field.writeInt32LE(mtimeSec, 5);
  return field;
}

function dosFields(y: number, mo: number, d: number, h: number, mi: number, s: number) {
  return {
    dosDate: ((y - 1980) << 9) | (mo << 5) | d,
    dosTime: (h << 11) | (mi << 5) | (s >> 1),
  };
}

function entryWith(extra: Buffer, dos = { dosDate: 0, dosTime: 0 }): ReadEntry {
  return {
    archivePath: "f.txt",
    type: "file",
    method: 0,
    crc32: 0,
    compSize: 0,
    uncompSize: 0,
    localOffset: 0,
    gpFlag: 0,
    externalAttr: 0,
    dosDate: dos.dosDate,
    dosTime: dos.dosTime,
    extra,
  };
}

describe("restoreTimes source selection", () => {
  it("reads mtime and atime from the NTFS extra when present (highest fidelity)", () => {
    const mtime = Date.UTC(2020, 0, 1, 12, 0, 0);
    const atime = Date.UTC(2020, 0, 2, 6, 30, 0);
    const t = restoreTimes(entryWith(ntfsExtra(mtime, atime)), "UTC");
    expect(t.mtimeMs).toBe(mtime);
    expect(t.atimeMs).toBe(atime);
  });

  it("prefers the NTFS extra over the UT extra when both are present", () => {
    const ntfsMs = Date.UTC(2020, 0, 1, 0, 0, 0);
    const utSec = Date.UTC(1999, 5, 6, 0, 0, 0) / 1000;
    const extra = Buffer.concat([utExtra(utSec), ntfsExtra(ntfsMs, ntfsMs)]);
    expect(restoreTimes(entryWith(extra), "UTC").mtimeMs).toBe(ntfsMs);
  });

  it("falls back to the UT extra (UTC seconds) when there is no NTFS extra", () => {
    const sec = Date.UTC(2010, 6, 15, 8, 9, 10) / 1000;
    const t = restoreTimes(entryWith(utExtra(sec)), "UTC");
    expect(t.mtimeMs).toBe(sec * 1000);
    expect(t.atimeMs).toBe(sec * 1000); // central UT carries only mtime; atime mirrors it
  });

  it("decodes the DOS field in UTC when no absolute extra is present", () => {
    const t = restoreTimes(entryWith(Buffer.alloc(0), dosFields(2003, 4, 5, 6, 7, 8)), "UTC");
    expect(t.mtimeMs).toBe(Date.UTC(2003, 3, 5, 6, 7, 8));
  });

  it("interprets the zone-less DOS field in the configured timezone", () => {
    // Asia/Tokyo is UTC+9 year-round; that wall clock is nine hours earlier in UTC.
    const t = restoreTimes(entryWith(Buffer.alloc(0), dosFields(2003, 4, 5, 6, 7, 8)), "Asia/Tokyo");
    expect(t.mtimeMs).toBe(Date.UTC(2003, 3, 5, 6, 7, 8) - 9 * 3600 * 1000);
  });
});
