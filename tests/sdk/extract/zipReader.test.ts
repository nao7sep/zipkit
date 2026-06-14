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
import { parseZip, readEntryData, type ReadEntry } from "../../../src/sdk/extract/zipReader.js";

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
}): Buffer {
  const nb = Buffer.from(opts.name, "utf8");
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0);
  c.writeUInt16LE(20, 4); // version made by
  c.writeUInt16LE(20, 6); // version needed
  c.writeUInt16LE(opts.method ?? 0, 10);
  c.writeUInt32LE(opts.compSize ?? 0, 20);
  c.writeUInt32LE(opts.uncompSize ?? 0, 24);
  c.writeUInt16LE(nb.length, 28);
  c.writeUInt32LE(opts.localOffset ?? 0, 42);
  return Buffer.concat([c, nb]);
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
});
