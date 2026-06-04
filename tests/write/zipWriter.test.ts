/**
 * Writer byte-contract tests. Build an archive, read it back, and
 * assert the cleanliness guarantees: the UTF-8 flag is set, the host byte is 0
 * (FAT), no unexpected extra field is present, directories end in a slash, and
 * stored/deflated content round-trips with a matching CRC. The deliberate
 * exceptions — the extended-timestamp extra under preservation, Zip64
 * structures, and a preserved symlink's Unix host byte and mode — are asserted
 * where they apply.
 */

import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildZip } from "../../src/write/zipWriter.js";
import type { PreparedEntry, ZipWriterOptions } from "../../src/write/zipWriter.js";
import { findExtra, readZip } from "../helpers/readZip.js";

const Y2020_NS = 1_577_836_800_000_000_000n;
// 100-ns ticks between 1601 (FILETIME epoch) and 1970, for decoding NTFS times.
const NTFS_EPOCH_OFFSET = 116_444_736_000_000_000n;

function fileEntry(name: string, content: Buffer, deflate: boolean): PreparedEntry {
  const data = deflate ? zlib.deflateRawSync(content) : content;
  return {
    name,
    type: "file",
    method: deflate ? "deflate" : "store",
    crc32: zlib.crc32(content),
    data,
    uncompressedSize: content.length,
    mtimeNs: Y2020_NS,
    atimeNs: Y2020_NS,
    birthtimeNs: Y2020_NS,
    mode: 0o644,
  };
}

const baseOptions: ZipWriterOptions = {
  zip64: false,
  preserveTimestamps: false,
  timeZone: "UTC",
};

describe("buildZip byte contract", () => {
  it("sets the UTF-8 flag, FAT host byte, and zero extra fields", () => {
    const content = Buffer.from("hello hello hello hello", "utf8");
    const { bytes } = buildZip([fileEntry("dir/a.txt", content, true)], baseOptions);
    const { entries } = readZip(bytes);
    const entry = entries[0];
    expect(entry?.gpFlag).toBe(0x0800);
    expect(entry?.hostByte).toBe(0);
    expect(entry?.externalAttr).toBe(0);
    expect(entry?.centralExtraLength).toBe(0);
    expect(entry?.localExtraLength).toBe(0);
  });

  it("round-trips stored and deflated content with matching CRC", () => {
    const a = Buffer.from("a".repeat(200), "utf8");
    const b = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const { bytes } = buildZip(
      [fileEntry("a.txt", a, true), fileEntry("b.bin", b, false)],
      baseOptions,
    );
    const { entries } = readZip(bytes);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName["a.txt"]?.method).toBe(8);
    expect(byName["a.txt"]?.content.equals(a)).toBe(true);
    expect(byName["a.txt"]?.crc32).toBe(zlib.crc32(a));
    expect(byName["b.bin"]?.method).toBe(0);
    expect(byName["b.bin"]?.content.equals(b)).toBe(true);
  });

  it("writes a directory entry with a trailing slash and zero size", () => {
    const dir: PreparedEntry = {
      name: "folder",
      type: "dir",
      method: "store",
      crc32: 0,
      data: Buffer.alloc(0),
      uncompressedSize: 0,
      mtimeNs: Y2020_NS,
      atimeNs: Y2020_NS,
      birthtimeNs: Y2020_NS,
      mode: 0,
    };
    const { entries } = readZip(buildZip([dir], baseOptions).bytes);
    expect(entries[0]?.name).toBe("folder/");
    expect(entries[0]?.uncompSize).toBe(0);
    expect(entries[0]?.externalAttr).toBe(0x10);
  });
});

const dosHour = (t: number): number => (t >> 11) & 0x1f;
const dosDay = (d: number): number => d & 0x1f;
const dosMonth = (d: number): number => (d >> 5) & 0xf;

describe("timestamps", () => {
  it("floors the DOS time and writes no extra field under clamp", () => {
    const old = fileEntry("old.txt", Buffer.from("x"), false);
    old.mtimeNs = 0n; // 1970
    const { entries } = readZip(buildZip([old], baseOptions).bytes);
    expect(entries[0]?.dosDate).toBe((1 << 5) | 1); // 1980-01-01
    expect(entries[0]?.dosTime).toBe(0);
    expect(entries[0]?.localExtraLength).toBe(0);
  });

  it("renders the DOS field in the configured local zone, not UTC", () => {
    // 2020-06-01T00:00:00Z. The DOS field has no zone, so each reader's wall
    // clock differs; the writer must bake in the chosen zone's local time.
    const entry = fileEntry("a.txt", Buffer.from("x"), false);
    entry.mtimeNs = BigInt(Date.UTC(2020, 5, 1)) * 1_000_000n;

    const utc = readZip(buildZip([entry], { ...baseOptions, timeZone: "UTC" }).bytes).entries[0];
    expect(dosHour(utc!.dosTime)).toBe(0);
    expect(dosDay(utc!.dosDate)).toBe(1);
    expect(dosMonth(utc!.dosDate)).toBe(6);

    // Asia/Tokyo is UTC+9 → 09:00 the same day.
    const jst = readZip(buildZip([entry], { ...baseOptions, timeZone: "Asia/Tokyo" }).bytes)
      .entries[0];
    expect(dosHour(jst!.dosTime)).toBe(9);
    expect(dosDay(jst!.dosDate)).toBe(1);

    // America/Los_Angeles is UTC−7 (PDT) in June → 17:00 the previous day.
    const pdt = readZip(
      buildZip([entry], { ...baseOptions, timeZone: "America/Los_Angeles" }).bytes,
    ).entries[0];
    expect(dosHour(pdt!.dosTime)).toBe(17);
    expect(dosDay(pdt!.dosDate)).toBe(31);
    expect(dosMonth(pdt!.dosDate)).toBe(5);
  });

  it("writes the UT and NTFS extras with all three times under preservation", () => {
    const entry = fileEntry("a.txt", Buffer.from("data"), false);
    const { entries } = readZip(
      buildZip([entry], { ...baseOptions, preserveTimestamps: true }).bytes,
    );
    const e = entries[0]!;
    // UT local: flags + 3×4-byte times = 13 data bytes; NTFS: 32 data bytes.
    expect(e.localExtraLength).toBe(4 + 13 + (4 + 32));
    // UT central carries only the modtime (flags + 1×4 = 5 data bytes).
    expect(e.centralExtraLength).toBe(4 + 5 + (4 + 32));

    const utLocal = findExtra(e.localExtra, 0x5455)!;
    expect(utLocal[0]).toBe(0x07); // mod | access | create
    expect(utLocal.length).toBe(13);
    const utCentral = findExtra(e.centralExtra, 0x5455)!;
    expect(utCentral.length).toBe(5);
    expect(utCentral.readInt32LE(1)).toBe(Number(Y2020_NS / 1_000_000_000n));

    const ntfs = findExtra(e.localExtra, 0x000a)!;
    const mtimeFiletime = ntfs.readBigUInt64LE(8); // after reserved(4) + tag1(2) + size1(2)
    expect((mtimeFiletime - NTFS_EPOCH_OFFSET) * 100n).toBe(Y2020_NS);
  });

  it("clamps when the zone offset pushes a UTC-in-range instant out of the DOS window", () => {
    // 1980-01-01T00:00:00Z is in UTC range, but in Los Angeles it is local 1979
    // → must clamp to the DOS minimum, not overflow the packed year field.
    const lo = fileEntry("lo.txt", Buffer.from("x"), false);
    lo.mtimeNs = BigInt(Date.UTC(1980, 0, 1)) * 1_000_000n;
    const loEntry = readZip(
      buildZip([lo], { ...baseOptions, timeZone: "America/Los_Angeles" }).bytes,
    ).entries[0];
    expect(loEntry?.dosDate).toBe((1 << 5) | 1);
    expect(loEntry?.dosTime).toBe(0);

    // 2107-12-31T23:00:00Z is in UTC range, but in Tokyo it is local 2108
    // → must clamp to the DOS maximum.
    const hi = fileEntry("hi.txt", Buffer.from("x"), false);
    hi.mtimeNs = BigInt(Date.UTC(2107, 11, 31, 23)) * 1_000_000n;
    const hiEntry = readZip(buildZip([hi], { ...baseOptions, timeZone: "Asia/Tokyo" }).bytes)
      .entries[0];
    expect(hiEntry?.dosDate).toBe(((2107 - 1980) << 9) | (12 << 5) | 31);
  });

  it("does not assert a creation time when birthtime is unavailable (0)", () => {
    const entry = fileEntry("a.txt", Buffer.from("data"), false);
    entry.birthtimeNs = 0n; // platform reports no creation time
    const { entries } = readZip(
      buildZip([entry], { ...baseOptions, preserveTimestamps: true }).bytes,
    );
    const e = entries[0]!;
    // UT drops the creation bit: only modification | access remain.
    expect(findExtra(e.localExtra, 0x5455)![0]).toBe(0x03);
    // NTFS writes the creation field as the FILETIME unset sentinel (0).
    expect(findExtra(e.localExtra, 0x000a)!.readBigUInt64LE(24)).toBe(0n);
  });

  it("clamps a far-future mtime to the DOS maximum without crashing", () => {
    const entry = fileEntry("future.txt", Buffer.from("x"), false);
    entry.mtimeNs = BigInt(Date.UTC(2200, 0, 1)) * 1_000_000n;
    const { entries } = readZip(buildZip([entry], baseOptions).bytes);
    expect(entries[0]?.dosDate).toBe(((2107 - 1980) << 9) | (12 << 5) | 31);
  });

  it("drops only the out-of-range time from the UT extra, keeping NTFS full-range", () => {
    const entry = fileEntry("future.txt", Buffer.from("x"), false);
    entry.mtimeNs = BigInt(Date.UTC(2050, 0, 1)) * 1_000_000n; // past the UT 2038 ceiling
    const { entries } = readZip(
      buildZip([entry], { ...baseOptions, preserveTimestamps: true }).bytes,
    );
    const e = entries[0]!;
    const utLocal = findExtra(e.localExtra, 0x5455)!;
    expect(utLocal[0]).toBe(0x06); // mod bit clear; access | create remain
    // NTFS spans the full Unix range, so the 2050 modtime survives there.
    const ntfs = findExtra(e.localExtra, 0x000a)!;
    expect((ntfs.readBigUInt64LE(8) - NTFS_EPOCH_OFFSET) * 100n).toBe(entry.mtimeNs);
  });

  it("omits the UT extra entirely when all times exceed its range, but writes NTFS", () => {
    const entry = fileEntry("ancient.txt", Buffer.from("x"), false);
    const far = BigInt(Date.UTC(2050, 0, 1)) * 1_000_000n;
    entry.mtimeNs = far;
    entry.atimeNs = far;
    entry.birthtimeNs = far;
    const { entries } = readZip(
      buildZip([entry], { ...baseOptions, preserveTimestamps: true }).bytes,
    );
    const e = entries[0]!;
    expect(findExtra(e.localExtra, 0x5455)).toBeNull();
    expect(findExtra(e.localExtra, 0x000a)).not.toBeNull();
    expect(e.localExtraLength).toBe(4 + 32);
  });
});

describe("symlink exception", () => {
  it("carries a Unix host byte and link mode for a preserved symlink", () => {
    const link: PreparedEntry = {
      name: "link",
      type: "symlink",
      method: "store",
      crc32: zlib.crc32(Buffer.from("target")),
      data: Buffer.from("target"),
      uncompressedSize: 6,
      mtimeNs: Y2020_NS,
      atimeNs: Y2020_NS,
      birthtimeNs: Y2020_NS,
      mode: 0o120777,
    };
    const { entries } = readZip(buildZip([link], baseOptions).bytes);
    expect(entries[0]?.hostByte).toBe(3); // Unix
    expect(entries[0]?.externalAttr >>> 16).toBe(0o120777);
    expect(entries[0]?.content.toString("utf8")).toBe("target");
  });
});

describe("zip64", () => {
  it("emits the Zip64 end-of-central-directory and locator when forced", () => {
    const result = buildZip([fileEntry("a.txt", Buffer.from("x"), false)], {
      ...baseOptions,
      zip64: true,
    });
    expect(result.zip64).toBe(true);
    const read = readZip(result.bytes);
    expect(read.hasZip64Eocd).toBe(true);
    expect(read.hasZip64Locator).toBe(true);
    expect(read.entries[0]?.content.toString("utf8")).toBe("x");
  });

  it("writes a per-entry Zip64 extra and 0xFFFFFFFF base fields for an over-4GB size", () => {
    // Byte-level check only: the declared size exceeds the (tiny) data, so the
    // archive is intentionally not extractable here.
    const entry: PreparedEntry = {
      name: "big.bin",
      type: "file",
      method: "store",
      crc32: 0,
      data: Buffer.from("x"),
      uncompressedSize: 5_000_000_000,
      mtimeNs: Y2020_NS,
      atimeNs: Y2020_NS,
      birthtimeNs: Y2020_NS,
      mode: 0o644,
    };
    const { bytes } = buildZip([entry], baseOptions);
    // Local header: compressed/uncompressed size fields are the Zip64 sentinel.
    expect(bytes.readUInt32LE(18)).toBe(0xffffffff);
    expect(bytes.readUInt32LE(22)).toBe(0xffffffff);
    // The local extra field begins with the Zip64 header id 0x0001.
    const nameLen = bytes.readUInt16LE(26);
    const extraStart = 30 + nameLen;
    expect(bytes.readUInt16LE(extraStart)).toBe(0x0001);
  });
});
