/**
 * Writer byte-contract tests. The writer streams to a file now, so each test
 * builds a real archive, reads it back, and asserts the cleanliness guarantees:
 * the UTF-8 flag is set, the host byte is 0 (FAT) unless an entry carries a Unix
 * mode, the always-on timestamp extras (UT + NTFS) are the only extras present,
 * directories end in a slash, and stored/deflated content round-trips with a
 * matching CRC. Zip64 structures and the Unix host byte and mode of a regular
 * file or preserved symlink are asserted where they apply. Because the writer computes the CRC and
 * compressed size from the streamed bytes (no precomputed data buffer), the
 * tests also implicitly cover the seek-back header patching.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it, onTestFinished } from "vitest";
import { buildZipFile, type BuildOptions, type EntryWithData } from "../helpers/writeZip.ts";
import { findExtra, readZipFile } from "../helpers/readZip.ts";
import { CENTRAL_TIMESTAMP_EXTRA_MAX, LOCAL_TIMESTAMP_EXTRA_MAX } from "../../src/plan/zip64.ts";
import { ZipWriter } from "../../src/write/zipWriter.ts";
import { nodeFileSystem, Volume, type FileSystemPort } from "../../src/internal/volume.ts";
import { realVolume } from "../helpers/volume.ts";

const Y2020_NS = 1_577_836_800_000_000_000n;
// 100-ns ticks between 1601 (FILETIME epoch) and 1970, for decoding NTFS times.
const NTFS_EPOCH_OFFSET = 116_444_736_000_000_000n;

function fileEntry(name: string, content: Buffer, deflate: boolean): EntryWithData {
  return {
    name,
    type: "file",
    method: deflate ? "deflate" : "store",
    raw: content,
    uncompressedSize: content.length,
    mtimeNs: Y2020_NS,
    atimeNs: Y2020_NS,
    birthtimeNs: Y2020_NS,
    mode: 0o644,
  };
}

const baseOptions: BuildOptions = {
  timeZone: "UTC",
  chunkSize: 65536,
};

async function build(entries: EntryWithData[], opts?: Partial<BuildOptions>) {
  const built = await buildZipFile(entries, { ...baseOptions, ...opts });
  return { ...readZipFile(built.path), zip64: built.zip64 };
}

describe("buildZip byte contract", () => {
  it("sets the UTF-8 flag and FAT host byte, with only the timestamp extras", async () => {
    const content = Buffer.from("hello hello hello hello", "utf8");
    const { entries } = await build([fileEntry("dir/a.txt", content, true)]);
    const entry = entries[0];
    expect(entry?.gpFlag).toBe(0x0800);
    expect(entry?.hostByte).toBe(0);
    expect(entry?.externalAttr).toBe(0);
    // The always-on UT + NTFS extras are the only extras; no Zip64 for a tiny entry.
    expect(findExtra(entry!.localExtra, 0x0001)).toBeNull();
    expect(findExtra(entry!.localExtra, 0x5455)).not.toBeNull();
    expect(findExtra(entry!.localExtra, 0x000a)).not.toBeNull();
  });

  it("round-trips stored and deflated content with matching CRC", async () => {
    const a = Buffer.from("a".repeat(200), "utf8");
    const b = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const { entries } = await build([fileEntry("a.txt", a, true), fileEntry("b.bin", b, false)]);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName["a.txt"]?.method).toBe(8);
    expect(byName["a.txt"]?.content.equals(a)).toBe(true);
    expect(byName["a.txt"]?.crc32).toBe(zlib.crc32(a));
    expect(byName["b.bin"]?.method).toBe(0);
    expect(byName["b.bin"]?.content.equals(b)).toBe(true);
  });

  it("writes a directory entry with a trailing slash and zero size", async () => {
    const dir: EntryWithData = {
      name: "folder",
      type: "dir",
      method: "store",
      raw: Buffer.alloc(0),
      uncompressedSize: 0,
      mtimeNs: Y2020_NS,
      atimeNs: Y2020_NS,
      birthtimeNs: Y2020_NS,
      mode: 0,
    };
    const { entries } = await build([dir]);
    expect(entries[0]?.name).toBe("folder/");
    expect(entries[0]?.uncompSize).toBe(0);
    expect(entries[0]?.externalAttr).toBe(0x10);
  });
});

const dosHour = (t: number): number => (t >> 11) & 0x1f;
const dosDay = (d: number): number => d & 0x1f;
const dosMonth = (d: number): number => (d >> 5) & 0xf;

describe("timestamps", () => {
  it("floors a pre-1980 DOS time to the minimum", async () => {
    const old = fileEntry("old.txt", Buffer.from("x"), false);
    old.mtimeNs = 0n; // 1970
    const { entries } = await build([old]);
    expect(entries[0]?.dosDate).toBe((1 << 5) | 1); // 1980-01-01
    expect(entries[0]?.dosTime).toBe(0);
  });

  it("renders the DOS field in the configured local zone, not UTC", async () => {
    // 2020-06-01T00:00:00Z. The DOS field has no zone, so each reader's wall
    // clock differs; the writer must bake in the chosen zone's local time.
    const entry = fileEntry("a.txt", Buffer.from("x"), false);
    entry.mtimeNs = BigInt(Date.UTC(2020, 5, 1)) * 1_000_000n;

    const utc = (await build([entry], { timeZone: "UTC" })).entries[0];
    expect(dosHour(utc!.dosTime)).toBe(0);
    expect(dosDay(utc!.dosDate)).toBe(1);
    expect(dosMonth(utc!.dosDate)).toBe(6);

    // Asia/Tokyo is UTC+9 → 09:00 the same day.
    const jst = (await build([entry], { timeZone: "Asia/Tokyo" })).entries[0];
    expect(dosHour(jst!.dosTime)).toBe(9);
    expect(dosDay(jst!.dosDate)).toBe(1);

    // America/Los_Angeles is UTC−7 (PDT) in June → 17:00 the previous day.
    const pdt = (await build([entry], { timeZone: "America/Los_Angeles" })).entries[0];
    expect(dosHour(pdt!.dosTime)).toBe(17);
    expect(dosDay(pdt!.dosDate)).toBe(31);
    expect(dosMonth(pdt!.dosDate)).toBe(5);
  });

  it("writes the UT and NTFS extras with all three times", async () => {
    const entry = fileEntry("a.txt", Buffer.from("data"), false);
    const { entries } = await build([entry]);
    const e = entries[0]!;
    // UT local: flags + 3×4-byte times = 13 data bytes; NTFS: 32 data bytes.
    expect(e.localExtraLength).toBe(4 + 13 + (4 + 32));
    // UT central carries only the modtime (flags + 1×4 = 5 data bytes).
    expect(e.centralExtraLength).toBe(4 + 5 + (4 + 32));
    // These maxima are what the Zip64 estimate counts per record; keep them in
    // lockstep so a change to the writer's extras can't silently underreport.
    expect(e.localExtraLength).toBe(LOCAL_TIMESTAMP_EXTRA_MAX);
    expect(e.centralExtraLength).toBe(CENTRAL_TIMESTAMP_EXTRA_MAX);

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

  it("clamps when the zone offset pushes a UTC-in-range instant out of the DOS window", async () => {
    // 1980-01-01T00:00:00Z is in UTC range, but in Los Angeles it is local 1979
    // → must clamp to the DOS minimum, not overflow the packed year field.
    const lo = fileEntry("lo.txt", Buffer.from("x"), false);
    lo.mtimeNs = BigInt(Date.UTC(1980, 0, 1)) * 1_000_000n;
    const loEntry = (await build([lo], { timeZone: "America/Los_Angeles" })).entries[0];
    expect(loEntry?.dosDate).toBe((1 << 5) | 1);
    expect(loEntry?.dosTime).toBe(0);

    // 2107-12-31T23:00:00Z is in UTC range, but in Tokyo it is local 2108
    // → must clamp to the DOS maximum.
    const hi = fileEntry("hi.txt", Buffer.from("x"), false);
    hi.mtimeNs = BigInt(Date.UTC(2107, 11, 31, 23)) * 1_000_000n;
    const hiEntry = (await build([hi], { timeZone: "Asia/Tokyo" })).entries[0];
    expect(hiEntry?.dosDate).toBe(((2107 - 1980) << 9) | (12 << 5) | 31);
  });

  it("does not assert a creation time when birthtime is unavailable (0)", async () => {
    const entry = fileEntry("a.txt", Buffer.from("data"), false);
    entry.birthtimeNs = 0n; // platform reports no creation time
    const { entries } = await build([entry]);
    const e = entries[0]!;
    // UT drops the creation bit: only modification | access remain.
    expect(findExtra(e.localExtra, 0x5455)![0]).toBe(0x03);
    // NTFS writes the creation field as the FILETIME unset sentinel (0).
    expect(findExtra(e.localExtra, 0x000a)!.readBigUInt64LE(24)).toBe(0n);
  });

  it("clamps a far-future mtime to the DOS maximum without crashing", async () => {
    const entry = fileEntry("future.txt", Buffer.from("x"), false);
    entry.mtimeNs = BigInt(Date.UTC(2200, 0, 1)) * 1_000_000n;
    const { entries } = await build([entry]);
    expect(entries[0]?.dosDate).toBe(((2107 - 1980) << 9) | (12 << 5) | 31);
  });

  it("drops only the out-of-range time from the UT extra, keeping NTFS full-range", async () => {
    const entry = fileEntry("future.txt", Buffer.from("x"), false);
    entry.mtimeNs = BigInt(Date.UTC(2050, 0, 1)) * 1_000_000n; // past the UT 2038 ceiling
    const { entries } = await build([entry]);
    const e = entries[0]!;
    const utLocal = findExtra(e.localExtra, 0x5455)!;
    expect(utLocal[0]).toBe(0x06); // mod bit clear; access | create remain
    // NTFS spans the full Unix range, so the 2050 modtime survives there.
    const ntfs = findExtra(e.localExtra, 0x000a)!;
    expect((ntfs.readBigUInt64LE(8) - NTFS_EPOCH_OFFSET) * 100n).toBe(entry.mtimeNs);
  });

  it("omits the UT extra entirely when all times exceed its range, but writes NTFS", async () => {
    const entry = fileEntry("ancient.txt", Buffer.from("x"), false);
    const far = BigInt(Date.UTC(2050, 0, 1)) * 1_000_000n;
    entry.mtimeNs = far;
    entry.atimeNs = far;
    entry.birthtimeNs = far;
    const { entries } = await build([entry]);
    const e = entries[0]!;
    expect(findExtra(e.localExtra, 0x5455)).toBeNull();
    expect(findExtra(e.localExtra, 0x000a)).not.toBeNull();
    expect(e.localExtraLength).toBe(4 + 32);
  });
});

describe("Unix modes", () => {
  it("carries a Unix host byte and the permission mode for a regular file", async () => {
    const file = { ...fileEntry("tool.sh", Buffer.from("#!/bin/sh\n"), false), mode: 0o100755 };
    const { entries } = await build([file]);
    expect(entries[0]?.hostByte).toBe(3); // Unix
    expect((entries[0]!.externalAttr >>> 16)).toBe(0o100755);
  });

  it("carries a Unix host byte and link mode for a preserved symlink", async () => {
    const link: EntryWithData = {
      name: "link",
      type: "symlink",
      method: "store",
      raw: Buffer.from("target"),
      uncompressedSize: 6,
      mtimeNs: Y2020_NS,
      atimeNs: Y2020_NS,
      birthtimeNs: Y2020_NS,
      mode: 0o120777,
    };
    const { entries } = await build([link]);
    expect(entries[0]?.hostByte).toBe(3); // Unix
    expect((entries[0]!.externalAttr >>> 16)).toBe(0o120777);
    expect(entries[0]?.content.toString("utf8")).toBe("target");
  });
});

describe("temp file shape", () => {
  it("uses <outputStem>-<nanoid>.tmp beside the output, not a hidden pid/epoch dotfile", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zk-writer-shape-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const output = path.join(dir, "archive.zip");
    const writer = new ZipWriter(output, baseOptions, realVolume());
    await writer.open();

    // While open, the only file in the directory is the temp — assert its shape
    // directly rather than reaching into the writer's private state.
    const midWrite = readdirSync(dir);
    expect(midWrite).toHaveLength(1);
    expect(midWrite[0]).toMatch(/^archive-[A-Za-z0-9_-]{21}\.tmp$/);
    expect(midWrite[0]?.startsWith(".")).toBe(false); // not a hidden dotfile
    expect(midWrite[0]?.split(".").length).toBe(2); // one role extension, no `.zip.tmp` stacking

    await writer.finalize(false);
    expect(readdirSync(dir)).toEqual(["archive.zip"]); // renamed into place, temp gone
  });
});

describe("zip64", () => {
  it.each([
    { label: "sizes exactly at the sentinel", payload: 0xffffffff },
    { label: "sizes with nonzero high bits", payload: 0x1_1234_5678 },
    // A classic first header: 30 + one-byte name + 53 timestamp-extra bytes.
    { label: "second local offset exactly at the sentinel", payload: 0xffffffff - 84 },
  ])("encodes actual writer geometry for $label", async ({ payload }) => {
    const writes: { position: number; bytes: Buffer }[] = [];
    // This token never reaches native I/O. Its length stands for a sparse data
    // extent while the real Volume and writer still advance their own offsets.
    const extent = Buffer.alloc(0);
    Object.defineProperty(extent, "length", { value: payload });
    const port: FileSystemPort = {
      ...nodeFileSystem,
      open: async () => ({
        write: async (buffer, offset, length, position) => {
          expect(position).not.toBeNull();
          if (buffer !== extent) writes.push({ position: position!, bytes: Buffer.from(buffer.subarray(offset, offset + length)) });
          return { bytesWritten: length };
        },
        read: async () => { throw new Error("writer must not read its output"); },
        stat: async () => { throw new Error("writer must not stat its open output"); },
        sync: async () => {}, close: async () => {},
      }),
      stat: async () => { throw Object.assign(new Error("no previous output"), { code: "ENOENT" }); },
      chmod: async () => {}, rename: async () => {}, syncDirectory: async () => {},
    };
    const writer = new ZipWriter(path.join(tmpdir(), "zipkit-synthetic.zip"), { ...baseOptions, overwrite: true }, new Volume(port, 30_000));
    // Decode the captured on-wire bytes independently, overlaying positioned
    // local-header patches without allocating the unwritten sparse payload.
    const read = (position: number, length: number) => {
      const result = Buffer.alloc(length);
      for (const write of writes) {
        const start = Math.max(position, write.position);
        const end = Math.min(position + length, write.position + write.bytes.length);
        if (end > start) write.bytes.copy(result, start - position, start - write.position, end - write.position);
      }
      return result;
    };
    const local = (position: number) => {
      const header = read(position, 30);
      expect(header.readUInt32LE(0)).toBe(0x04034b50);
      expect(header.readUInt16LE(6) & 8).toBe(0); // Patched headers; no data descriptors.
      const extra = read(position + 30 + header.readUInt16LE(26), header.readUInt16LE(28));
      return { header, extra, end: position + 30 + header.readUInt16LE(26) + extra.length };
    };
    await writer.open();
    const large = { ...fileEntry("a", Buffer.alloc(0), false), uncompressedSize: payload };
    await writer.streamEntry(large, async (sink) => {
      await sink(extent);
      return { crc32: 0x12345678, compressedSize: payload, uncompressedSize: payload };
    });
    const first = local(0);
    const secondOffset = first.end + payload;
    expect(secondOffset).toBeGreaterThanOrEqual(0xffffffff);
    if (payload === 0xffffffff - 84) expect(secondOffset).toBe(0xffffffff);
    await writer.streamEntry(fileEntry("b", Buffer.alloc(0), false), async () => ({ crc32: 0, compressedSize: 0, uncompressedSize: 0 }));
    const second = local(secondOffset);
    const cdStart = second.end;
    const result = await writer.finalize(false);
    expect(result.zip64).toBe(true);
    expect(result.publication).toBe("published");
    expect(first.header.readUInt32LE(14)).toBe(0x12345678);
    const firstZip64 = payload >= 0xffffffff;
    expect(first.header.readUInt32LE(18)).toBe(firstZip64 ? 0xffffffff : payload);
    expect(first.header.readUInt32LE(22)).toBe(firstZip64 ? 0xffffffff : payload);
    if (firstZip64) {
      const sizes = findExtra(first.extra, 1)!;
      expect(sizes.readBigUInt64LE(0)).toBe(BigInt(payload));
      expect(sizes.readBigUInt64LE(8)).toBe(BigInt(payload));
    } else expect(findExtra(first.extra, 1)).toBeNull();
    expect(second.header.readUInt32LE(18)).toBe(0xffffffff);
    expect(second.header.readUInt32LE(22)).toBe(0xffffffff);
    expect(findExtra(second.extra, 1)!.readBigUInt64LE(0)).toBe(0n);
    expect(findExtra(second.extra, 1)!.readBigUInt64LE(8)).toBe(0n);

    let centralAt = cdStart;
    for (const [size, offset, zip64] of [[payload, 0, firstZip64], [0, secondOffset, true]] as const) {
      const header = read(centralAt, 46);
      expect(header.readUInt32LE(0)).toBe(0x02014b50);
      expect(header.readUInt32LE(20)).toBe(zip64 ? 0xffffffff : size);
      expect(header.readUInt32LE(24)).toBe(zip64 ? 0xffffffff : size);
      expect(header.readUInt32LE(42)).toBe(zip64 ? 0xffffffff : offset);
      const extra = read(centralAt + 46 + header.readUInt16LE(28), header.readUInt16LE(30));
      if (zip64) {
        const values = findExtra(extra, 1)!;
        expect(values.readBigUInt64LE(0)).toBe(BigInt(size));
        expect(values.readBigUInt64LE(8)).toBe(BigInt(size));
        expect(values.readBigUInt64LE(16)).toBe(BigInt(offset));
      } else expect(findExtra(extra, 1)).toBeNull();
      centralAt += 46 + header.readUInt16LE(28) + extra.length;
    }
    const end64 = read(centralAt, 56);
    expect(end64.readUInt32LE(0)).toBe(0x06064b50);
    expect(end64.readBigUInt64LE(32)).toBe(2n);
    expect(end64.readBigUInt64LE(40)).toBe(BigInt(centralAt - cdStart));
    expect(end64.readBigUInt64LE(48)).toBe(BigInt(cdStart));
    const locator = read(centralAt + 56, 20);
    expect(locator.readUInt32LE(0)).toBe(0x07064b50);
    expect(locator.readBigUInt64LE(8)).toBe(BigInt(centralAt));
    const end = read(centralAt + 76, 22);
    expect(end.readUInt32LE(0)).toBe(0x06054b50);
    expect(end.readUInt32LE(16)).toBe(0xffffffff);
    expect(result.bytes).toBe(centralAt + 98);
  });

  it("emits the Zip64 end-of-central-directory and locator when forced", async () => {
    const result = await build([fileEntry("a.txt", Buffer.from("x"), false)], { zip64: true });
    expect(result.zip64).toBe(true);
    expect(result.hasZip64Eocd).toBe(true);
    expect(result.hasZip64Locator).toBe(true);
    expect(result.entries[0]?.content.toString("utf8")).toBe("x");
  });

  it("forces Zip64 structures even for a small archive when requested", async () => {
    // The streaming writer fixes each entry's header format from its known
    // uncompressed size and offset, so a real over-4GB entry cannot be faked
    // here; instead assert the container-level Zip64 records appear and the
    // tiny entry still round-trips intact.
    const result = await build([fileEntry("small.txt", Buffer.from("hi"), true)], { zip64: true });
    expect(result.hasZip64Eocd).toBe(true);
    expect(result.entries[0]?.content.toString("utf8")).toBe("hi");
  });

  it("picks the Zip64 header format for a near-4 GiB deflate entry, but not for store", async () => {
    // Deflate can expand incompressible input, so an entry whose declared size is
    // just under the 32-bit limit could compress to ≥ 4 GiB and overflow a 32-bit
    // size field at patch time. The writer must choose the Zip64 format up front
    // from the deflate bound. A store entry of the same size cannot expand, so it
    // stays in classic format. (The streamed bytes are tiny — a real 4 GiB payload
    // can't be created in a unit test; only the declared size drives the format.)
    const justUnder = 0xffffffff - 1000;

    const deflated = fileEntry("big.bin", Buffer.from("x"), true);
    deflated.uncompressedSize = justUnder;
    const d = await build([deflated]);
    expect(findExtra(d.entries[0]!.localExtra, 0x0001)).not.toBeNull(); // Zip64 local extra present
    expect(d.entries[0]?.content.toString("utf8")).toBe("x"); // still round-trips

    const stored = fileEntry("big.bin", Buffer.from("x"), false);
    stored.uncompressedSize = justUnder;
    const s = await build([stored]);
    expect(findExtra(s.entries[0]!.localExtra, 0x0001)).toBeNull(); // store: no expansion, no Zip64
    expect(s.entries[0]?.content.toString("utf8")).toBe("x");
  });
});
