/**
 * Extract/validate tests. Archives are built with the in-house writer, written
 * to a temp dir, then read back through the public `extract` operation. Covers
 * the dry/heavy matrix, CRC and SHA verification, completeness, path safety,
 * exclusion, timestamp restoration, and Zip64.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipKit } from "../../src/index.js";
import { buildZip } from "../../src/write/zipWriter.js";
import type { PreparedEntry, ZipWriterOptions } from "../../src/write/zipWriter.js";

const Y2020_NS = 1_577_836_800_000_000_000n;
const Y2020_MS = 1_577_836_800_000;

const writerOptions: ZipWriterOptions = {
  zip64: false,
  deterministic: false,
  preserveTimestamps: true,
  timeZone: "UTC",
};

function fileEntry(name: string, content: string, crcOverride?: number): PreparedEntry {
  const data = Buffer.from(content, "utf8");
  return {
    name,
    type: "file",
    method: "store",
    crc32: crcOverride ?? zlib.crc32(data),
    data,
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

async function writeArchive(entries: PreparedEntry[], opts?: Partial<ZipWriterOptions>): Promise<string> {
  const bytes = buildZip(entries, { ...writerOptions, ...opts }).bytes;
  const archive = path.join(dir, "a.zip");
  await writeFile(archive, bytes);
  return archive;
}

describe("extract round-trip", () => {
  it("writes verified entries and restores the modification time", async () => {
    const archive = await writeArchive([fileEntry("docs/readme.txt", "hello world")]);
    const dest = path.join(dir, "out");
    const report = await new ZipKit().extract({ archive, dest });

    expect(report.ok).toBe(true);
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
    expect(report.ok).toBe(true);
    expect(report.wrote).toBe(false);
    expect(report.entries.every((e) => e.crc === "ok" && e.skipped === "dry-run")).toBe(true);
  });

  it("reports a CRC failure and refuses to write the corrupt entry", async () => {
    // A stored CRC that disagrees with the content stands in for corruption.
    const archive = await writeArchive([fileEntry("bad.txt", "payload", 0x12345678)]);
    const dest = path.join(dir, "out");
    const report = await new ZipKit().extract({ archive, dest });
    expect(report.ok).toBe(false);
    expect(report.entries[0]?.crc).toBe("fail");
    expect(report.entries[0]?.written).toBe(false);
    expect(report.findings.some((f) => f.rule === "extract.crc-fail")).toBe(true);
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
    expect(report.ok).toBe(false);
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
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual([]);
  });
});

describe("path safety and exclusion", () => {
  it("skips a zip-slip entry and never writes outside the destination", async () => {
    const archive = await writeArchive([fileEntry("../evil.txt", "pwned"), fileEntry("ok.txt", "fine")]);
    const dest = path.join(dir, "out");
    const report = await new ZipKit().extract({ archive, dest });
    expect(report.ok).toBe(false);
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
    expect(report.ok).toBe(true);
    expect((await readFile(path.join(dest, "keep.bin"))).toString()).toBe("b");
  });
});

describe("symlinks and zip64", () => {
  it("restores a symlink entry, or skips it under symlinks: skip", async () => {
    const link: PreparedEntry = {
      name: "link",
      type: "symlink",
      method: "store",
      crc32: zlib.crc32(Buffer.from("target.txt")),
      data: Buffer.from("target.txt"),
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

  it("reads and round-trips a Zip64 archive", async () => {
    const archive = await writeArchive([fileEntry("z.txt", "zip64 content")], { zip64: true });
    const dest = path.join(dir, "out");
    const report = await new ZipKit().extract({ archive, dest });
    expect(report.ok).toBe(true);
    expect((await readFile(path.join(dest, "z.txt"))).toString()).toBe("zip64 content");
  });
});
