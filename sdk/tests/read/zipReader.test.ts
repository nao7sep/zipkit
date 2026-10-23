/**
 * Robustness of the ZIP reader against malformed input — the path behind
 * "validate any ZIP". Each case crafts a deliberately broken archive on disk and
 * asserts the specific read error code, so a corrupt or truncated file fails
 * cleanly and diagnosably rather than mis-parsing.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localHeaderMismatch, parseZip, readEntryData, type ReadEntry } from "../../src/read/zipReader.ts";
import type { VolumeFile } from "../../src/internal/volume.ts";
import { openRead } from "../helpers/volume.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zk-reader-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function eocd(opts: { count: number; cdSize: number; cdOffset: number; comment?: Buffer }): Buffer {
  const comment = opts.comment ?? Buffer.alloc(0);
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(opts.count, 8);
  b.writeUInt16LE(opts.count, 10);
  b.writeUInt32LE(opts.cdSize, 12);
  b.writeUInt32LE(opts.cdOffset, 16);
  b.writeUInt16LE(comment.length, 20);
  return Buffer.concat([b, comment]);
}

function central(opts: {
  name: string | Buffer;
  gpFlag?: number;
  crc32?: number;
  method?: number;
  compSize?: number;
  uncompSize?: number;
  localOffset?: number;
  extra?: Buffer;
}): Buffer {
  const nb = typeof opts.name === "string" ? Buffer.from(opts.name, "utf8") : opts.name;
  const extra = opts.extra ?? Buffer.alloc(0);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0);
  c.writeUInt16LE(20, 4); // version made by
  c.writeUInt16LE(20, 6); // version needed
  c.writeUInt16LE(opts.gpFlag ?? 0, 8);
  c.writeUInt16LE(opts.method ?? 0, 10);
  c.writeUInt32LE(opts.crc32 ?? 0, 16);
  c.writeUInt32LE(opts.compSize ?? 0, 20);
  c.writeUInt32LE(opts.uncompSize ?? 0, 24);
  c.writeUInt16LE(nb.length, 28);
  c.writeUInt16LE(extra.length, 30);
  c.writeUInt32LE(opts.localOffset ?? 0, 42);
  return Buffer.concat([c, nb, extra]);
}

async function parse(bytes: Buffer) {
  const file = path.join(dir, "a.zip");
  await writeFile(file, bytes);
  const fh = await openRead(file);
  try {
    return await parseZip(fh, bytes.length);
  } finally {
    await fh.close();
  }
}

describe("parseZip rejects malformed archives", () => {
  it("a file too small to hold an EOCD", async () => {
    await expect(parse(Buffer.alloc(10))).rejects.toMatchObject({ code: "archive.not-zip" });
  });

  it("a file with no end-of-central-directory signature", async () => {
    await expect(parse(Buffer.alloc(200))).rejects.toMatchObject({ code: "archive.not-zip" });
  });

  it("an EOCD whose central-directory location is out of range", async () => {
    await expect(parse(eocd({ count: 1, cdSize: 50, cdOffset: 1_000_000 }))).rejects.toMatchObject({
      code: "archive.malformed",
    });
  });

  it("an EOCD pointing at bytes that are not a central record", async () => {
    const fakeCd = Buffer.alloc(10); // no central signature
    const bytes = Buffer.concat([fakeCd, eocd({ count: 1, cdSize: fakeCd.length, cdOffset: 0 })]);
    await expect(parse(bytes)).rejects.toMatchObject({ code: "archive.malformed" });
  });

  it("a Zip64 sentinel with a missing required extra value", async () => {
    const cd = central({ name: "x", uncompSize: 0xffffffff });
    const bytes = Buffer.concat([cd, eocd({ count: 1, cdSize: cd.length, cdOffset: 0 })]);
    await expect(parse(bytes)).rejects.toMatchObject({ code: "archive.malformed" });
  });

  it("a Zip64 value outside JavaScript's safe integer range", async () => {
    const payload = Buffer.alloc(8);
    payload.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    const extra = Buffer.alloc(4 + payload.length);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(payload.length, 2);
    payload.copy(extra, 4);
    const cd = central({ name: "x", uncompSize: 0xffffffff, extra });
    const bytes = Buffer.concat([cd, eocd({ count: 1, cdSize: cd.length, cdOffset: 0 })]);
    await expect(parse(bytes)).rejects.toMatchObject({ code: "archive.malformed" });
  });

  it("a Zip64 end record with a truncated declared structure", async () => {
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(1n, 4); // must be at least 44 bytes after the size field
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(0n, 8);
    const end = eocd({ count: 0xffff, cdSize: 0, cdOffset: 0xffffffff });
    await expect(parse(Buffer.concat([z64, locator, end]))).rejects.toMatchObject({
      code: "archive.malformed",
    });
  });
});

describe("readEntryData rejects unreadable entries", () => {
  async function parsedFirst(bytes: Buffer): Promise<{ fd: VolumeFile; entry: ReadEntry; close: () => Promise<void> }> {
    const file = path.join(dir, "b.zip");
    await writeFile(file, bytes);
    const fh = await openRead(file);
    const parsed = await parseZip(fh, bytes.length);
    return { fd: fh, entry: parsed.entries[0]!, close: () => fh.close() };
  }

  it("rejects an unsupported compression method", async () => {
    const cd = central({ name: "x", method: 99, compSize: 0 });
    const bytes = Buffer.concat([cd, eocd({ count: 1, cdSize: cd.length, cdOffset: 0 })]);
    const { fd, entry, close } = await parsedFirst(bytes);
    try {
      await expect(readEntryData(fd, entry, async () => {}, 65536)).rejects.toMatchObject({
        code: "archive.unsupported-method",
      });
    } finally {
      await close();
    }
  });

  it("rejects an entry whose local header is missing its signature", async () => {
    // 30 junk bytes stand in for the local-header region; the central record
    // points its localOffset at them, so the data-offset read finds no signature.
    const junk = Buffer.alloc(30);
    const cd = central({ name: "x", method: 0, compSize: 5, uncompSize: 5, localOffset: 0 });
    const bytes = Buffer.concat([
      junk,
      cd,
      eocd({ count: 1, cdSize: cd.length, cdOffset: junk.length }),
    ]);
    const { fd, entry, close } = await parsedFirst(bytes);
    try {
      await expect(readEntryData(fd, entry, async () => {}, 65536)).rejects.toMatchObject({
        code: "archive.malformed",
      });
    } finally {
      await close();
    }
  });

  it.each([3, 7])("refuses inflated bytes that disagree with the declared size: declared %i", async (declared) => {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    const data = Buffer.from("12345");
    const file = path.join(dir, "bounded.zip");
    await writeFile(file, Buffer.concat([local, data]));
    const fh = await openRead(file);
    const entry: ReadEntry = {
      archivePath: "zipkit.json",
      type: "file",
      method: 0,
      crc32: 0,
      compSize: data.length,
      uncompSize: declared,
      localOffset: 0,
      gpFlag: 0,
      externalAttr: 0,
      dosDate: 0,
      dosTime: 0,
      extra: Buffer.alloc(0),
      nameBytes: Buffer.alloc(0),
    };
    try {
      await expect(readEntryData(fh, entry, async () => {}, 65536)).rejects.toMatchObject({ code: "archive.size-mismatch" });
    } finally {
      await fh.close();
    }
  });
});

describe("central-directory geometry and bounded reads", () => {
  it.each([
    { count: 0, declared: 47, actual: 47 },
    { count: 1, declared: 46, actual: 47 },
    { count: 1, declared: 48, actual: 47 },
  ])("rejects a count or size that does not describe the records: %j", async ({ count, declared, actual }) => {
    const cd = central({ name: "x" });
    expect(cd.length).toBe(actual);
    await expect(parse(Buffer.concat([cd, eocd({ count, cdSize: declared, cdOffset: 0 })])))
      .rejects.toMatchObject({ code: "archive.malformed" });
  });

  it("reads records independently and does not retain their unused comments", async () => {
    const records = Array.from({ length: 12 }, (_, i) => {
      const record = central({ name: `entry-${i}`, extra: Buffer.from([2, 0, 0, 0]) });
      record.writeUInt16LE(65535, 32);
      return Buffer.concat([record, Buffer.alloc(65535)]);
    });
    const cd = Buffer.concat(records);
    const bytes = Buffer.concat([cd, eocd({ count: records.length, cdSize: cd.length, cdOffset: 0 })]);
    const file = path.join(dir, "comments.zip");
    await writeFile(file, bytes);
    const fh = await openRead(file);
    const lengths: number[] = [];
    const read = fh.read.bind(fh);
    fh.read = async (buffer, offset, length, position) => {
      lengths.push(length);
      return read(buffer, offset, length, position);
    };
    try {
      const parsed = await parseZip(fh, bytes.length);
      expect(parsed.entries.map((e) => e.archivePath)).toEqual(records.map((_, i) => `entry-${i}`));
      expect(Math.max(...lengths)).toBeLessThanOrEqual(2 * 65535);
      expect(parsed.entries.every((e) => e.extra.buffer.byteLength <= 2 * 65535 && e.nameBytes.buffer.byteLength <= 2 * 65535)).toBe(true);
    } finally {
      await fh.close();
    }
  });
});

describe("directory location records", () => {
  it.each([false, true])("supports Zip64=%s with a maximum archive comment", async (zip64) => {
    const cd = central({ name: "x" });
    const comment = Buffer.alloc(65535, 97);
    comment.writeUInt32LE(0x06054b50, 100); // an embedded signature is not the EOCD
    if (!zip64) {
      expect((await parse(Buffer.concat([cd, eocd({ count: 1, cdSize: cd.length, cdOffset: 0, comment })]))).entries[0]?.archivePath).toBe("x");
      return;
    }
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeBigUInt64LE(1n, 24);
    record.writeBigUInt64LE(1n, 32);
    record.writeBigUInt64LE(BigInt(cd.length), 40);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(cd.length), 8);
    const end = eocd({ count: 0xffff, cdSize: 0xffffffff, cdOffset: 0xffffffff, comment });
    const bytes = Buffer.concat([cd, record, locator, end]);
    expect(await parse(bytes)).toMatchObject({ zip64: true, entries: [{ archivePath: "x" }] });
    record.writeBigUInt64LE(BigInt(cd.length + 1), 40);
    await expect(parse(Buffer.concat([cd, record, locator, end]))).rejects.toMatchObject({ code: "archive.malformed" });
    record.writeBigUInt64LE(BigInt(cd.length), 40);
    record.writeBigUInt64LE(2n, 32);
    await expect(parse(Buffer.concat([cd, record, locator, end]))).rejects.toMatchObject({ code: "archive.malformed" });
  });

  it.each([0, 8 * 1024 * 1024])("does not read irrelevant payload for an empty directory at %i", async (cdOffset) => {
    const payloadSize = 8 * 1024 * 1024;
    const end = eocd({ count: 0, cdSize: 0, cdOffset });
    const lengths: number[] = [];
    const file = {
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        lengths.push(length);
        buffer.fill(0, offset, offset + length);
        const from = Math.max(position, payloadSize);
        const to = Math.min(position + length, payloadSize + end.length);
        if (from < to) end.copy(buffer, offset + from - position, from - payloadSize, to - payloadSize);
        return length;
      },
    } as VolumeFile;
    if (cdOffset === 0) {
      await expect(parseZip(file, payloadSize + end.length)).rejects.toMatchObject({ code: "archive.malformed" });
    } else {
      expect(await parseZip(file, payloadSize + end.length)).toEqual({ zip64: false, entries: [] });
    }
    expect(Math.max(...lengths)).toBeLessThanOrEqual(22 + 65535 + 20);
  });
});


it("batches small central records into bounded positioned reads", async () => {
  const records = Array.from({ length: 4000 }, (_, i) => central({ name: `file-${i}` }));
  const cd = Buffer.concat(records);
  const bytes = Buffer.concat([cd, eocd({ count: records.length, cdSize: cd.length, cdOffset: 0 })]);
  const file = path.join(dir, "many-small-records.zip");
  await writeFile(file, bytes);
  const fh = await openRead(file);
  let reads = 0;
  const read = fh.read.bind(fh);
  fh.read = async (...args) => { reads++; return read(...args); };
  try {
    expect((await parseZip(fh, bytes.length)).entries).toHaveLength(records.length);
    expect(reads).toBeLessThanOrEqual(2 * Math.ceil(cd.length / 65536) + 2);
  } finally {
    await fh.close();
  }
});

it("accepts an optional central digital signature and refuses unrelated trailing bytes", async () => {
  const cd = central({ name: "signed.txt" });
  const signature = Buffer.alloc(6 + 65535, 97);
  signature.writeUInt32LE(0x05054b50, 0);
  signature.writeUInt16LE(65535, 4);
  const signed = () => Buffer.concat([cd, signature, eocd({ count: 1, cdSize: cd.length + signature.length, cdOffset: 0 })]);
  expect((await parse(signed())).entries[0]?.archivePath).toBe("signed.txt");
  signature.writeUInt16LE(65534, 4);
  await expect(parse(signed())).rejects.toMatchObject({ code: "archive.malformed" });
  signature.writeUInt16LE(65535, 4);
  signature.writeUInt32LE(0x01020304, 0);
  await expect(parse(signed())).rejects.toMatchObject({ code: "archive.malformed" });
});

it("supports maximum format-sized name and extra fields across read-ahead blocks", async () => {
  const name = "n".repeat(65535);
  const extra = Buffer.alloc(65535);
  const cd = central({ name, extra });
  const parsed = await parse(Buffer.concat([cd, eocd({ count: 1, cdSize: cd.length, cdOffset: 0 })]));
  expect(parsed.entries[0]?.archivePath).toBe(name);
  expect(parsed.entries[0]?.extra.equals(extra)).toBe(true);
});

describe("filename encodings", () => {
  async function nameFrom(name: Buffer, gpFlag = 0, extra = Buffer.alloc(0)): Promise<string> {
    const cd = central({ name, gpFlag, extra });
    return (await parse(Buffer.concat([cd, eocd({ count: 1, cdSize: cd.length, cdOffset: 0 })]))).entries[0]!.archivePath;
  }

  it("decodes legacy raw filenames as CP437", async () => {
    expect(await nameFrom(Buffer.from([0x82, 0x2e, 0x74, 0x78, 0x74]))).toBe("é.txt");
  });

  it("decodes filenames marked as UTF-8", async () => {
    expect(await nameFrom(Buffer.from("日本語.txt", "utf8"), 0x0800)).toBe("日本語.txt");
    expect(await nameFrom(Buffer.from("\ufeffname.txt", "utf8"), 0x0800)).toBe("\ufeffname.txt");
  });

  it.each([true, false])("uses a version-1 Unicode path only when its raw-name CRC matches: %s", async (matches) => {
    const rawName = Buffer.from([0x82, 0x2e, 0x74, 0x78, 0x74]);
    const unicodeName = Buffer.from("別名.txt", "utf8");
    const extra = Buffer.alloc(9 + unicodeName.length);
    extra.writeUInt16LE(0x7075, 0);
    extra.writeUInt16LE(5 + unicodeName.length, 2);
    extra[4] = 1;
    extra.writeUInt32LE(matches ? crc32(rawName) : (crc32(rawName) ^ 1) >>> 0, 5);
    unicodeName.copy(extra, 9);
    expect(await nameFrom(rawName, 0, extra)).toBe(matches ? "別名.txt" : "é.txt");
  });

  it("rejects malformed filenames marked as UTF-8", async () => {
    await expect(nameFrom(Buffer.from([0xc3, 0x28]), 0x0800)).rejects.toMatchObject({ code: "archive.malformed" });
  });
});

/** Build a streaming ZIP record directly; no archive writer participates. */
function descriptorFixture(signed: boolean, wide: boolean): { bytes: Buffer; descriptorStart: number; descriptorLength: number } {
  const name = Buffer.from("stream.txt");
  const data = Buffer.from("streamed payload");
  const checksum = crc32(data);
  const extra = wide ? Buffer.alloc(20) : Buffer.alloc(0);
  if (wide) {
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(16, 2);
    extra.writeBigUInt64LE(BigInt(data.length), 4);
    extra.writeBigUInt64LE(BigInt(data.length), 12);
  }
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(wide ? 45 : 20, 4);
  local.writeUInt16LE(0x0008, 6);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(extra.length, 28);
  const descriptor = Buffer.alloc((signed ? 4 : 0) + (wide ? 20 : 12));
  const start = signed ? 4 : 0;
  if (signed) descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(checksum, start);
  if (wide) {
    descriptor.writeBigUInt64LE(BigInt(data.length), start + 4);
    descriptor.writeBigUInt64LE(BigInt(data.length), start + 12);
  } else {
    descriptor.writeUInt32LE(data.length, start + 4);
    descriptor.writeUInt32LE(data.length, start + 8);
  }
  const payload = Buffer.concat([local, name, extra, data]);
  const cd = central({
    name, gpFlag: 0x0008, crc32: checksum,
    compSize: wide ? 0xffffffff : data.length,
    uncompSize: wide ? 0xffffffff : data.length,
    extra,
  });
  return {
    bytes: Buffer.concat([payload, descriptor, cd, eocd({ count: 1, cdSize: cd.length, cdOffset: payload.length + descriptor.length })]),
    descriptorStart: payload.length,
    descriptorLength: descriptor.length,
  };
}

async function withFirstEntry(bytes: Buffer, run: (file: VolumeFile, entry: ReadEntry) => Promise<void>): Promise<void> {
  const file = path.join(dir, "fixture.zip");
  await writeFile(file, bytes);
  const fd = await openRead(file);
  try {
    const parsed = await parseZip(fd, bytes.length);
    await run(fd, parsed.entries[0]!);
  } finally {
    await fd.close();
  }
}

describe("streaming data descriptors", () => {
  const forms = [
    { signed: false, wide: false }, { signed: true, wide: false },
    { signed: false, wide: true }, { signed: true, wide: true },
  ];

  it("does not mistake a ZIP64 offset alone for wide descriptor sizes", async () => {
    const { bytes, descriptorStart, descriptorLength } = descriptorFixture(true, false);
    const payload = bytes.subarray(0, descriptorStart + descriptorLength);
    const extra = Buffer.alloc(12);
    extra.writeUInt16LE(1, 0);
    extra.writeUInt16LE(8, 2);
    extra.writeBigUInt64LE(0n, 4);
    const cd = central({ name: "stream.txt", gpFlag: 8, crc32: crc32(Buffer.from("streamed payload")),
      compSize: 16, uncompSize: 16, localOffset: 0xffffffff, extra });
    const fixture = Buffer.concat([payload, cd, eocd({ count: 1, cdSize: cd.length, cdOffset: payload.length })]);
    await withFirstEntry(fixture, async (file, entry) => {
      expect(await localHeaderMismatch(file, entry)).toBeNull();
    });
  });

  it.each(forms)("accepts a matching descriptor: %j", async ({ signed, wide }) => {
    await withFirstEntry(descriptorFixture(signed, wide).bytes, async (file, entry) => {
      expect(await localHeaderMismatch(file, entry)).toBeNull();
    });
  });

  it.each([false, true])("rejects disagreement between local and central bit 3: local=%s", async (localSet) => {
    const { bytes, descriptorStart, descriptorLength } = descriptorFixture(true, false);
    bytes.writeUInt16LE(localSet ? 0x0008 : 0, 6);
    bytes.writeUInt16LE(localSet ? 0 : 0x0008, descriptorStart + descriptorLength + 8);
    await withFirstEntry(bytes, async (file, entry) => {
      expect(await localHeaderMismatch(file, entry)).toBe("data descriptor flag differs");
    });
  });

  it.each(forms.flatMap((form) => ["crc", "compressed size", "uncompressed size"].map((field) => ({ ...form, field }))))(
    "rejects an incorrect descriptor field: %j", async ({ signed, wide, field }) => {
      const { bytes, descriptorStart } = descriptorFixture(signed, wide);
      const fieldOffset = field === "crc" ? 0 : field === "compressed size" ? 4 : wide ? 12 : 8;
      const offset = descriptorStart + (signed ? 4 : 0) + fieldOffset;
      bytes[offset] = bytes[offset]! ^ 1;
      await withFirstEntry(bytes, async (file, entry) => {
        expect(await localHeaderMismatch(file, entry)).toBe("data descriptor differs");
      });
    },
  );

  it.each(forms)("rejects a descriptor truncated before its last byte: %j", async ({ signed, wide }) => {
    const { bytes, descriptorStart, descriptorLength } = descriptorFixture(signed, wide);
    const entry = (await parse(bytes)).entries[0]!;
    const target = path.join(dir, "truncated-descriptor.zip");
    await writeFile(target, bytes.subarray(0, descriptorStart + descriptorLength - 1));
    const file = await openRead(target);
    try {
      await expect(localHeaderMismatch(file, entry)).rejects.toMatchObject({ code: "archive.malformed" });
    } finally {
      await file.close();
    }
  });
});

describe("compressed read failure ownership", () => {
  function compressedFixture(corrupt = false): { bytes: Buffer; dataStart: number } {
    const name = Buffer.from("compressed.txt");
    const content = Buffer.from("the original decompressed payload");
    const data = corrupt ? Buffer.from([0x07]) : deflateRawSync(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    const cd = central({ name, method: 8, compSize: data.length, uncompSize: content.length, crc32: crc32(content) });
    const payload = Buffer.concat([local, name, data]);
    return { bytes: Buffer.concat([payload, cd, eocd({ count: 1, cdSize: cd.length, cdOffset: payload.length })]), dataStart: local.length + name.length };
  }

  it("preserves an EIO failure from reading compressed bytes", async () => {
    const { bytes, dataStart } = compressedFixture();
    const failure = Object.assign(new Error("disk read failed"), { code: "EIO" });
    await withFirstEntry(bytes, async (file, entry) => {
      const read = file.read.bind(file);
      file.read = async (buffer, offset, length, position) => {
        if (position >= dataStart) throw failure;
        return read(buffer, offset, length, position);
      };
      await expect(readEntryData(file, entry, async () => {}, 64)).rejects.toBe(failure);
    });
  });

  it("preserves a SyntaxError thrown by the decompressed-data sink", async () => {
    const failure = new SyntaxError("sink rejected the payload");
    await withFirstEntry(compressedFixture().bytes, async (file, entry) => {
      await expect(readEntryData(file, entry, async () => { throw failure; }, 64)).rejects.toBe(failure);
    });
  });

  it("classifies an invalid deflate block as corrupt archive data", async () => {
    await withFirstEntry(compressedFixture(true).bytes, async (file, entry) => {
      await expect(readEntryData(file, entry, async () => {}, 64)).rejects.toMatchObject({ code: "archive.corrupt-data" });
    });
  });
});
