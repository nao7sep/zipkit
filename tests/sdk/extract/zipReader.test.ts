/**
 * Robustness of the ZIP reader against malformed input — the path behind
 * "validate any ZIP". Each case crafts a deliberately broken archive on disk and
 * asserts the specific ReadError code, so a corrupt or truncated file fails
 * cleanly and diagnosably rather than mis-parsing.
 */

import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseZip, readEntryBuffer, readEntryData, type ReadEntry } from "../../../src/sdk/extract/zipReader.js";

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
  name: string;
  method?: number;
  compSize?: number;
  uncompSize?: number;
  localOffset?: number;
  extra?: Buffer;
}): Buffer {
  const nb = Buffer.from(opts.name, "utf8");
  const extra = opts.extra ?? Buffer.alloc(0);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0);
  c.writeUInt16LE(20, 4); // version made by
  c.writeUInt16LE(20, 6); // version needed
  c.writeUInt16LE(opts.method ?? 0, 10);
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
  const fh = await open(file, "r");
  try {
    return await parseZip(fh.fd, bytes.length);
  } finally {
    await fh.close();
  }
}

describe("parseZip rejects malformed archives", () => {
  it("a file too small to hold an EOCD", async () => {
    await expect(parse(Buffer.alloc(10))).rejects.toMatchObject({ code: "read.not-zip" });
  });

  it("a file with no end-of-central-directory signature", async () => {
    await expect(parse(Buffer.alloc(200))).rejects.toMatchObject({ code: "read.not-zip" });
  });

  it("an EOCD whose central-directory location is out of range", async () => {
    await expect(parse(eocd({ count: 1, cdSize: 50, cdOffset: 1_000_000 }))).rejects.toMatchObject({
      code: "read.malformed",
    });
  });

  it("an EOCD pointing at bytes that are not a central record", async () => {
    const fakeCd = Buffer.alloc(10); // no central signature
    const bytes = Buffer.concat([fakeCd, eocd({ count: 1, cdSize: fakeCd.length, cdOffset: 0 })]);
    await expect(parse(bytes)).rejects.toMatchObject({ code: "read.malformed" });
  });

  it("a Zip64 sentinel with a missing required extra value", async () => {
    const cd = central({ name: "x", uncompSize: 0xffffffff });
    const bytes = Buffer.concat([cd, eocd({ count: 1, cdSize: cd.length, cdOffset: 0 })]);
    await expect(parse(bytes)).rejects.toMatchObject({ code: "read.malformed" });
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
    await expect(parse(bytes)).rejects.toMatchObject({ code: "read.malformed" });
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
      code: "read.malformed",
    });
  });
});

describe("readEntryData rejects unreadable entries", () => {
  async function parsedFirst(bytes: Buffer): Promise<{ fd: number; entry: ReadEntry; close: () => Promise<void> }> {
    const file = path.join(dir, "b.zip");
    await writeFile(file, bytes);
    const fh = await open(file, "r");
    const parsed = await parseZip(fh.fd, bytes.length);
    return { fd: fh.fd, entry: parsed.entries[0]!, close: () => fh.close() };
  }

  it("rejects an unsupported compression method", async () => {
    const cd = central({ name: "x", method: 99, compSize: 0 });
    const bytes = Buffer.concat([cd, eocd({ count: 1, cdSize: cd.length, cdOffset: 0 })]);
    const { fd, entry, close } = await parsedFirst(bytes);
    try {
      await expect(readEntryData(fd, entry, async () => {}, 65536)).rejects.toMatchObject({
        code: "read.unsupported-method",
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
        code: "read.malformed",
      });
    } finally {
      await close();
    }
  });

  it("bounds entries read into memory", async () => {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    const data = Buffer.from("12345");
    const file = path.join(dir, "bounded.zip");
    await writeFile(file, Buffer.concat([local, data]));
    const fh = await open(file, "r");
    const entry: ReadEntry = {
      archivePath: "_metadata.json",
      type: "file",
      method: 0,
      crc32: 0,
      compSize: data.length,
      uncompSize: data.length,
      localOffset: 0,
      gpFlag: 0,
      externalAttr: 0,
      dosDate: 0,
      dosTime: 0,
      extra: Buffer.alloc(0),
    };
    try {
      await expect(readEntryBuffer(fh.fd, entry, 4)).rejects.toMatchObject({
        code: "read.entry-too-large",
      });
    } finally {
      await fh.close();
    }
  });
});
