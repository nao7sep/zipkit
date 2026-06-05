/**
 * Extract/validate tests. Archives are built with the streaming in-house writer
 * into a temp dir, then read back through the public `extract` operation. Covers
 * the dry/heavy matrix, CRC and SHA verification, completeness, path safety,
 * exclusion, timestamp restoration, and Zip64.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipKit } from "../../src/index.js";
import type { ZipWriterOptions } from "../../src/write/zipWriter.js";
import { buildZipFile, type EntryWithData } from "../helpers/writeZip.js";

const Y2020_NS = 1_577_836_800_000_000_000n;
const Y2020_MS = 1_577_836_800_000;

const writerOptions: ZipWriterOptions = {
  zip64: false,
  preserveTimestamps: true,
  timeZone: "UTC",
  chunkSize: 65536,
};

function fileEntry(name: string, content: string): EntryWithData {
  const data = Buffer.from(content, "utf8");
  return {
    name,
    type: "file",
    method: "store",
    raw: data,
    uncompressedSize: data.length,
    mtimeNs: Y2020_NS,
    atimeNs: Y2020_NS,
    birthtimeNs: Y2020_NS,
    mode: 0o644,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "zk-extract-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeArchive(
  entries: EntryWithData[],
  opts?: Partial<ZipWriterOptions>,
): Promise<string> {
  const built = await buildZipFile(entries, { ...writerOptions, ...opts });
  const archive = path.join(dir, "a.zip");
  await writeFile(archive, await readFile(built.path));
  return archive;
}

describe("extract round-trip", () => {
  it("writes verified entries and restores the modification time", async () => {
    const archive = await writeArchive([fileEntry("docs/readme.txt", "hello world")]);
    const dest = path.join(dir, "out");
    const report = await new ZipKit().extract({ archive, dest });

    expect(report.reportOk).toBe(true);
    expect(report.wrote).toBe(true);
    expect(report.entries[0]?.crc).toBe("ok");
    const out = path.join(dest, "docs", "readme.txt");
    expect((await readFile(out)).toString()).toBe("hello world");
    // Restored from the absolute NTFS/UT extra → exact UTC instant.
    expect(Math.abs((await stat(out)).mtimeMs - Y2020_MS)).toBeLessThan(2000);
  });

  it("preserves an existing file unless overwrite is set", async () => {
    const archive = await writeArchive([fileEntry("a.txt", "new")]);
    const dest = path.join(dir, "out");
    await new ZipKit().extract({ archive, dest });
    await writeFile(path.join(dest, "a.txt"), "edited");

    const keep = await new ZipKit().extract({ archive, dest });
    expect(keep.entries[0]?.skipped).toBe("exists");
    expect((await readFile(path.join(dest, "a.txt"))).toString()).toBe("edited");

    const force = await new ZipKit().extract({ archive, dest, overwrite: true });
    expect(force.entries[0]?.written).toBe(true);
    expect((await readFile(path.join(dest, "a.txt"))).toString()).toBe("new");
  });
});

describe("dry-run validation", () => {
  it("verifies CRC and writes nothing on any zip", async () => {
    const archive = await writeArchive([fileEntry("a.txt", "x"), fileEntry("b.txt", "y")]);
    const report = await new ZipKit().extract({ archive, dryRun: true });
    expect(report.reportOk).toBe(true);
    expect(report.wrote).toBe(false);
    expect(report.entries.every((e) => e.crc === "ok" && e.skipped === "dry-run")).toBe(true);
  });

  it("reports a CRC failure and refuses to write the corrupt entry", async () => {
    // Build a valid archive, then flip a content byte on disk so the stored CRC
    // no longer matches — the streaming writer computes a correct CRC, so
    // corruption must be introduced after the fact.
    const archive = await writeArchive([fileEntry("bad.txt", "payload")]);
    const buf = await readFile(archive);
    const idx = buf.indexOf(Buffer.from("payload"));
    buf[idx] ^= 0xff;
    await writeFile(archive, buf);

    const dest = path.join(dir, "out");
    const report = await new ZipKit().extract({ archive, dest });
    expect(report.reportOk).toBe(false);
    expect(report.entries[0]?.crc).toBe("fail");
    expect(report.entries[0]?.written).toBe(false);
    expect(report.findings.some((f) => f.rule === "extract.crc-fail")).toBe(true);
    // The corrupt entry was never written to the destination.
    await expect(stat(path.join(dest, "bad.txt"))).rejects.toThrow();
  });
});

describe("heavy validation against a manifest", () => {
  it("verifies SHA and reports missing and extra entries from the embedded manifest", async () => {
    const aData = Buffer.from("alpha", "utf8");
    // The manifest is embedded in the archive: it claims a.txt (real sha) and a
    // phantom c.txt, and omits the real b.txt.
    const manifest = {
      entries: [
        { archivePath: "a.txt", sha256: createHash("sha256").update(aData).digest("hex") },
        { archivePath: "c.txt", sha256: "deadbeef" },
      ],
    };
    const archive = await writeArchive([
      fileEntry("a.txt", "alpha"),
      fileEntry("b.txt", "beta"),
      fileEntry("_metadata.json", JSON.stringify(manifest)),
    ]);

    const report = await new ZipKit().extract({ archive, dryRun: true, checkMetadata: true });
    expect(report.manifest?.name).toBe("_metadata.json");
    expect(report.entries.find((e) => e.archivePath === "a.txt")?.sha).toBe("ok");
    expect(report.missing).toEqual(["c.txt"]); // in manifest, not in archive
    expect(report.extra).toEqual(["b.txt"]); // in archive, not in manifest
    expect(report.reportOk).toBe(false);
  });

  it("hard-fails when heavy validation is requested but no manifest exists", async () => {
    const archive = await writeArchive([fileEntry("a.txt", "x")]);
    await expect(new ZipKit().extract({ archive, dryRun: true, checkMetadata: true })).rejects.toThrow(
      /manifest/i,
    );
  });

  it("validates an inside manifest end to end via create()", async () => {
    await writeFile(path.join(dir, "f1.txt"), "one");
    await writeFile(path.join(dir, "f2.txt"), "two");
    const archive = path.join(dir, "made.zip");
    await new ZipKit().create({
      inputs: [path.join(dir, "f1.txt"), path.join(dir, "f2.txt")],
      output: archive,
      overwrite: true,
      policy: { metadata: { name: "_metadata.json", hash: true } },
    });
    const report = await new ZipKit().extract({ archive, dryRun: true, checkMetadata: true });
    expect(report.manifest?.name).toBe("_metadata.json");
    expect(report.reportOk).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual([]);
  });
});

describe("path safety and exclusion", () => {
  it("skips a zip-slip entry and never writes outside the destination", async () => {
    const archive = await writeArchive([fileEntry("../evil.txt", "pwned"), fileEntry("ok.txt", "fine")]);
    const dest = path.join(dir, "out");
    const report = await new ZipKit().extract({ archive, dest });
    expect(report.reportOk).toBe(false);
    expect(report.entries.find((e) => e.archivePath === "../evil.txt")?.skipped).toBe("unsafe");
    expect(report.entries.find((e) => e.archivePath === "ok.txt")?.written).toBe(true);
    // The escaping path was not created next to the destination.
    await expect(stat(path.join(dir, "evil.txt"))).rejects.toThrow();
  });

  it("aborts the run on an unsafe entry when onUnsafe is abort", async () => {
    const archive = await writeArchive([fileEntry("../evil.txt", "x")]);
    await expect(
      new ZipKit().extract({ archive, dest: path.join(dir, "out"), onUnsafe: "abort" }),
    ).rejects.toThrow(/escapes/i);
  });

  it("leaves no temp stragglers when a write error aborts the pool mid-stream", async () => {
    // A plain file at dest/blocked makes the directory mkdir for "blocked/x.txt"
    // fail, throwing mid-pool while the large entries are still streaming. The
    // run must reject and leave no `.zk-*.tmp` behind: siblings run to completion
    // and clean up (no abandonment), and the failed entry rm's its own temp.
    const big = "x".repeat(2_000_000);
    const archive = await writeArchive([
      fileEntry("blocked/x.txt", "data"),
      fileEntry("big1.txt", big),
      fileEntry("big2.txt", big),
      fileEntry("big3.txt", big),
    ]);
    const dest = path.join(dir, "out");
    await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, "blocked"), "i block the directory");

    await expect(new ZipKit().extract({ archive, dest })).rejects.toThrow();

    const left = await readdir(dest);
    expect(left.some((f) => f.startsWith(".zk-"))).toBe(false);
  });

  it("does not write a literally-excluded entry", async () => {
    const archive = await writeArchive([fileEntry("keep.txt", "k"), fileEntry("_metadata.json", "{}")]);
    const dest = path.join(dir, "out");
    const report = await new ZipKit().extract({
      archive,
      dest,
      exclude: [{ pattern: "_metadata.json", match: "literal", target: "both" }],
    });
    expect(report.entries.find((e) => e.archivePath === "_metadata.json")?.skipped).toBe("excluded");
    await expect(stat(path.join(dest, "_metadata.json"))).rejects.toThrow();
    expect((await readFile(path.join(dest, "keep.txt"))).toString()).toBe("k");
  });

  it("applies glob/regex excludes on extract but still verifies the filtered entries", async () => {
    const archive = await writeArchive([
      fileEntry("a.txt", "a"),
      fileEntry("logs/run.log", "L"),
      fileEntry("keep.bin", "b"),
    ]);
    const dest = path.join(dir, "filtered");
    const report = await new ZipKit().extract({
      archive,
      dest,
      exclude: [
        { pattern: "*.txt", match: "glob", target: "both" },
        { pattern: "\\.log$", match: "regex", target: "both" },
      ],
    });
    // Excluded from writing...
    expect(report.entries.find((e) => e.archivePath === "a.txt")?.skipped).toBe("excluded");
    expect(report.entries.find((e) => e.archivePath === "logs/run.log")?.skipped).toBe("excluded");
    await expect(stat(path.join(dest, "a.txt"))).rejects.toThrow();
    await expect(stat(path.join(dest, "logs/run.log"))).rejects.toThrow();
    // ...but still CRC-verified (integrity covers the whole archive), and the rest written.
    expect(report.entries.every((e) => e.crc === "ok")).toBe(true);
    expect(report.reportOk).toBe(true);
    expect((await readFile(path.join(dest, "keep.bin"))).toString()).toBe("b");
  });
});

describe("symlinks and zip64", () => {
  it("restores a symlink entry, or skips it under symlinks: skip", async () => {
    const link: EntryWithData = {
      name: "link",
      type: "symlink",
      method: "store",
      raw: Buffer.from("target.txt"),
      uncompressedSize: 10,
      mtimeNs: Y2020_NS,
      atimeNs: Y2020_NS,
      birthtimeNs: Y2020_NS,
      mode: 0o120777,
    };
    const archive = await writeArchive([link]);

    const skip = await new ZipKit().extract({ archive, dest: path.join(dir, "skip"), symlinks: "skip" });
    expect(skip.entries[0]?.skipped).toBe("symlink-skip");

    const restored = await new ZipKit().extract({ archive, dest: path.join(dir, "keep") });
    expect(restored.entries[0]?.written).toBe(true);
    expect(await readlink(path.join(dir, "keep", "link"))).toBe("target.txt");
  });

  it("round-trips a zero-byte file (no compressed bytes to stream)", async () => {
    const archive = await writeArchive([fileEntry("empty.txt", ""), fileEntry("a.txt", "x")]);
    const dest = path.join(dir, "empties");
    const report = await new ZipKit().extract({ archive, dest });
    expect(report.reportOk).toBe(true);
    const empty = await stat(path.join(dest, "empty.txt"));
    expect(empty.size).toBe(0);
    expect((await readFile(path.join(dest, "a.txt"))).toString()).toBe("x");
  });

  it("reads and round-trips a Zip64 archive", async () => {
    const archive = await writeArchive([fileEntry("z.txt", "zip64 content")], { zip64: true });
    const dest = path.join(dir, "out");
    const report = await new ZipKit().extract({ archive, dest });
    expect(report.reportOk).toBe(true);
    expect((await readFile(path.join(dest, "z.txt"))).toString()).toBe("zip64 content");
  });
});

describe("large-file streaming round-trip", () => {
  it("round-trips a multi-megabyte file through create then extract with a matching SHA", async () => {
    // ~6 MB of pseudo-random (incompressible) plus compressible content, larger
    // than any single chunk, so the streaming read/deflate/write and the
    // streaming inflate/write both span many chunks.
    const src = path.join(dir, "src");
    await rm(src, { recursive: true, force: true });
    const big = Buffer.concat([
      randomBytes(3 * 1024 * 1024), // incompressible
      Buffer.from("compress me ".repeat(250_000), "utf8"), // deflate wins here
    ]);
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "big.bin"), big);
    const expectedSha = createHash("sha256").update(big).digest("hex");

    const archive = path.join(dir, "big.zip");
    await new ZipKit().create({ inputs: [src], output: archive, overwrite: true });

    const dest = path.join(dir, "big-out");
    const report = await new ZipKit().extract({ archive, dest });
    expect(report.reportOk).toBe(true);
    const roundTripped = await readFile(path.join(dest, "big.bin"));
    expect(createHash("sha256").update(roundTripped).digest("hex")).toBe(expectedSha);
  });

  it("honors a small chunkSize for both create and extract", async () => {
    const src = path.join(dir, "csrc");
    await mkdir(src, { recursive: true });
    const content = Buffer.from("chunked streaming ".repeat(5000), "utf8");
    await writeFile(path.join(src, "c.txt"), content);

    const archive = path.join(dir, "chunked.zip");
    // A tiny chunk size forces many read/deflate/write cycles per entry.
    await new ZipKit({ chunkSize: 64 }).create({ inputs: [src], output: archive, overwrite: true });
    const dest = path.join(dir, "chunked-out");
    const report = await new ZipKit({ chunkSize: 64 }).extract({ archive, dest });
    expect(report.reportOk).toBe(true);
    expect((await readFile(path.join(dest, "c.txt"))).equals(content)).toBe(true);
  });
});
