/**
 * Writer byte-contract tests (§11, §13). Build an archive, read it back, and
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
import { readZip } from "../helpers/readZip.js";

const Y2020_NS = 1_577_836_800_000_000_000n;

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
    mode: 0o644,
  };
}

const baseOptions: ZipWriterOptions = {
  zip64: false,
  deterministic: false,
  preserveTimestamps: false,
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
      mode: 0,
    };
    const { entries } = readZip(buildZip([dir], baseOptions).bytes);
    expect(entries[0]?.name).toBe("folder/");
    expect(entries[0]?.uncompSize).toBe(0);
    expect(entries[0]?.externalAttr).toBe(0x10);
  });
});

describe("timestamps", () => {
  it("floors the DOS time and writes no extra field under clamp", () => {
    const old = fileEntry("old.txt", Buffer.from("x"), false);
    old.mtimeNs = 0n; // 1970
    const { entries } = readZip(buildZip([old], baseOptions).bytes);
    expect(entries[0]?.dosDate).toBe((1 << 5) | 1); // 1980-01-01
    expect(entries[0]?.dosTime).toBe(0);
    expect(entries[0]?.localExtraLength).toBe(0);
  });

  it("uses a fixed time and is byte-identical under deterministic output", () => {
    const entry = fileEntry("a.txt", Buffer.from("data"), false);
    const det: ZipWriterOptions = { ...baseOptions, deterministic: true };
    const first = buildZip([entry], det).bytes;
    const second = buildZip([entry], det).bytes;
    expect(first.equals(second)).toBe(true);
    const { entries } = readZip(first);
    expect(entries[0]?.dosDate).toBe((1 << 5) | 1);
  });

  it("writes the extended-timestamp extra under preservation", () => {
    const entry = fileEntry("a.txt", Buffer.from("data"), false);
    const { entries } = readZip(
      buildZip([entry], { ...baseOptions, preserveTimestamps: true }).bytes,
    );
    expect(entries[0]?.localExtraLength).toBe(9);
    expect(entries[0]?.centralExtraLength).toBe(9);
  });

  it("clamps a far-future mtime to the DOS maximum without crashing", () => {
    const entry = fileEntry("future.txt", Buffer.from("x"), false);
    entry.mtimeNs = BigInt(Date.UTC(2200, 0, 1)) * 1_000_000n;
    const { entries } = readZip(buildZip([entry], baseOptions).bytes);
    expect(entries[0]?.dosDate).toBe(((2107 - 1980) << 9) | (12 << 5) | 31);
  });

  it("omits the extended-timestamp extra for a post-2038 mtime under preservation", () => {
    const entry = fileEntry("future.txt", Buffer.from("x"), false);
    entry.mtimeNs = BigInt(Date.UTC(2050, 0, 1)) * 1_000_000n;
    const { entries } = readZip(
      buildZip([entry], { ...baseOptions, preserveTimestamps: true }).bytes,
    );
    expect(entries[0]?.localExtraLength).toBe(0);
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
