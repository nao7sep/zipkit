/**
 * Extract/validate tests. Archives are built with the streaming in-house writer
 * into a temp dir, then read back through the public `extract` operation. Covers
 * the dry/heavy matrix, CRC and SHA verification, completeness, path safety,
 * exclusion, timestamp restoration, and Zip64.
 */

import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pLimit from "p-limit";
import { ZipKit } from "../../../src/sdk/index.js";
import { extractArchive } from "../../../src/sdk/extract/extract.js";
import { nodeFileSystem, Volume, type FileSystemPort } from "../../../src/sdk/internal/volume.js";
import { createLogger } from "../../../src/sdk/log/logger.js";
import { MANIFEST_FORMAT_VERSION } from "../../../src/sdk/write/metadata.js";
import { buildZipFile, type BuildOptions, type EntryWithData } from "../../helpers/writeZip.js";
import { createFileLink, fileSymlinksSupported } from "../../helpers/symlink.js";

const Y2020_NS = 1_577_836_800_000_000_000n;
const Y2020_MS = 1_577_836_800_000;

const writerOptions: BuildOptions = {
  zip64: false,
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

/** A symlink entry whose stored data is the (attacker-chosen) link target. */
function symlinkEntry(name: string, linkTarget: string): EntryWithData {
  const data = Buffer.from(linkTarget, "utf8");
  return {
    name,
    type: "symlink",
    method: "store",
    raw: data,
    uncompressedSize: data.length,
    mtimeNs: Y2020_NS,
    atimeNs: Y2020_NS,
    birthtimeNs: Y2020_NS,
    mode: 0o120777,
  };
}

/** A manifest record carrying every field a create writes and a verify checks. */
function manifestRecord(entry: EntryWithData, sha256?: string): Record<string, unknown> {
  const record: Record<string, unknown> = {
    archivePath: entry.name,
    sourcePath: entry.name,
    type: entry.type,
    size: entry.raw.length,
    crc32: crc32(entry.raw),
    mtime: { ns: entry.mtimeNs.toString() },
  };
  if (sha256 !== undefined) record.sha256 = sha256;
  return record;
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
  opts?: Partial<BuildOptions>,
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

  it("restores the time of a folder that holds files, archived by create", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(path.join(proj, "docs"), { recursive: true });
    await writeFile(path.join(proj, "docs", "file.txt"), "content");
    const Y2010 = new Date(Date.UTC(2010, 0, 1));
    await utimes(path.join(proj, "docs"), Y2010, Y2010);
    const archive = path.join(dir, "docs.zip");
    await new ZipKit().create({ inputs: [proj], output: archive });

    const dest = path.join(dir, "docs-out");
    await new ZipKit().extract({ archive, dest });

    expect((await stat(path.join(dest, "docs"))).mtimeMs).toBe(Y2010.getTime());
  });

  it("restores folder times after the folder's files are written", async () => {
    const Y2010_NS = 1_262_304_000_000_000_000n;
    const folder = (name: string): EntryWithData => ({
      name,
      type: "dir",
      method: "store",
      raw: Buffer.alloc(0),
      uncompressedSize: 0,
      mtimeNs: Y2010_NS,
      atimeNs: Y2010_NS,
      birthtimeNs: Y2010_NS,
      mode: 0o755,
    });
    // Folders come before their contents, as zipkit writes them, so a folder
    // stamped as it was created would be moved by the files written into it.
    const archive = await writeArchive([
      folder("docs"),
      folder("docs/sub"),
      fileEntry("docs/a.txt", "a"),
      fileEntry("docs/sub/b.txt", "b"),
    ]);
    const dest = path.join(dir, "out");
    const report = await new ZipKit().extract({ archive, dest });

    expect(report.reportOk).toBe(true);
    for (const name of ["docs", path.join("docs", "sub")]) {
      expect((await stat(path.join(dest, name))).mtimeMs).toBe(Number(Y2010_NS / 1_000_000n));
    }
    expect(Math.abs((await stat(path.join(dest, "docs", "a.txt"))).mtimeMs - Y2020_MS)).toBeLessThan(2000);

    const untouched = path.join(dir, "untouched");
    await new ZipKit().extract({ archive, dest: untouched, timestamps: "none" });
    expect((await stat(path.join(untouched, "docs"))).mtimeMs).toBeGreaterThan(Y2020_MS);
  });

  it("restores file and folder times at the NTFS extra's 100 ns", async () => {
    // 2020-01-01T00:00:00.1234567Z: digits below the millisecond, down to the
    // FILETIME's last 100 ns.
    const storedNs = Y2020_NS + 123_456_700n;
    const archive = await writeArchive([
      {
        name: "docs",
        type: "dir",
        method: "store",
        raw: Buffer.alloc(0),
        uncompressedSize: 0,
        mtimeNs: storedNs,
        atimeNs: storedNs,
        birthtimeNs: storedNs,
        mode: 0o755,
      },
      { ...fileEntry("docs/a.txt", "a"), mtimeNs: storedNs, atimeNs: storedNs },
    ]);
    const dest = path.join(dir, "out");
    await new ZipKit().extract({ archive, dest });

    for (const name of ["docs", path.join("docs", "a.txt")]) {
      const restored = await stat(path.join(dest, name), { bigint: true });
      for (const ns of [restored.mtimeNs, restored.atimeNs]) {
        const diff = ns - storedNs;
        expect(diff < 0n ? -diff : diff).toBeLessThan(100n);
      }
    }
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

  it("publishes one winner without clobber when two no-overwrite extracts race", async () => {
    const archive = await writeArchive([fileEntry("a.txt", "content")]);
    const dest = path.join(dir, "race-out");
    const [a, b] = await Promise.all([
      new ZipKit().extract({ archive, dest }),
      new ZipKit().extract({ archive, dest }),
    ]);
    const outcomes = [a.entries[0], b.entries[0]];
    expect(outcomes.filter((entry) => entry?.written)).toHaveLength(1);
    expect(outcomes.filter((entry) => entry?.skipped === "exists")).toHaveLength(1);
    expect(await readFile(path.join(dest, "a.txt"), "utf8")).toBe("content");
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
    buf[idx] = buf[idx]! ^ 0xff;
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
      formatVersion: MANIFEST_FORMAT_VERSION,
      entries: [
        manifestRecord(fileEntry("a.txt", "alpha"), createHash("sha256").update(aData).digest("hex")),
        manifestRecord(fileEntry("c.txt", "gamma"), "de".repeat(32)),
      ],
    };
    const archive = await writeArchive([
      fileEntry("a.txt", "alpha"),
      fileEntry("b.txt", "beta"),
      fileEntry("zipkit.json", JSON.stringify(manifest)),
    ]);

    const report = await new ZipKit().extract({ archive, dryRun: true, checkMetadata: true });
    expect(report.manifest?.name).toBe("zipkit.json");
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

  it("refuses a manifest a newer ZipKit wrote, leaving the archive as it is", async () => {
    const manifest = { formatVersion: MANIFEST_FORMAT_VERSION + 1, entries: [{ archivePath: "a.txt" }] };
    const archive = await writeArchive([fileEntry("a.txt", "alpha"), fileEntry("zipkit.json", JSON.stringify(manifest))]);
    const before = await readFile(archive);
    await expect(new ZipKit().extract({ archive, dryRun: true, checkMetadata: true })).rejects.toMatchObject({
      errorType: "read",
      code: "read.manifest-newer",
    });
    expect((await readFile(archive)).equals(before)).toBe(true);
  });

  it.each([undefined, 0, 1.5, "1"])("rejects a manifest without a positive integer format version: %j", async (formatVersion) => {
    const archive = await writeArchive([
      fileEntry("a.txt", "alpha"),
      fileEntry("zipkit.json", JSON.stringify({ formatVersion, entries: [{ archivePath: "a.txt" }] })),
    ]);
    await expect(new ZipKit().extract({ archive, dryRun: true, checkMetadata: true })).rejects.toMatchObject({
      code: "read.manifest-invalid",
    });
  });

  it("validates an inside manifest end to end via create()", async () => {
    await writeFile(path.join(dir, "f1.txt"), "one");
    await writeFile(path.join(dir, "f2.txt"), "two");
    const archive = path.join(dir, "made.zip");
    await new ZipKit().create({
      inputs: [path.join(dir, "f1.txt"), path.join(dir, "f2.txt")],
      output: archive,
      overwrite: true,
      policy: { metadata: { name: "zipkit.json", hash: true } },
    });
    const report = await new ZipKit().extract({ archive, dryRun: true, checkMetadata: true });
    expect(report.manifest?.name).toBe("zipkit.json");
    expect(report.reportOk).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual([]);
  });
});

describe("manifest size and CRC-32", () => {
  const recordFor = (entry: EntryWithData) => manifestRecord(entry);

  async function verify(entries: EntryWithData[], records: object[], opts?: Partial<BuildOptions>) {
    const archive = await writeArchive(
      [...entries, fileEntry("zipkit.json", JSON.stringify({ formatVersion: MANIFEST_FORMAT_VERSION, entries: records }))],
      opts,
    );
    return new ZipKit().extract({ archive, dryRun: true, checkMetadata: true });
  }

  it("fails an entry whose size differs from the manifest", async () => {
    const a = fileEntry("a.txt", "alpha");
    const report = await verify([a], [{ ...recordFor(a), size: 999 }]);
    expect(report.reportOk).toBe(false);
    expect(report.summary.manifestMismatched).toBe(1);
    expect(report.findings.filter((f) => f.rule === "extract.manifest-mismatch")).toEqual([
      expect.objectContaining({ path: "a.txt", severity: "error" }),
    ]);
  });

  it("fails an entry whose CRC-32 differs from the manifest even with no SHA-256 recorded", async () => {
    const a = fileEntry("a.txt", "alpha");
    const report = await verify([a], [{ ...recordFor(a), crc32: (crc32(a.raw) + 1) >>> 0 }]);
    expect(report.reportOk).toBe(false);
    expect(report.findings.map((f) => f.rule)).toContain("extract.manifest-mismatch");
  });

  it("passes matching records, a CRC-32 with the high bit set, a Zip64 entry and a symlink", async () => {
    // A content whose CRC-32 is at or above 2^31, so a signed comparison would differ.
    let high = fileEntry("high.txt", "h0");
    for (let i = 1; crc32(high.raw) < 0x80000000; i++) high = fileEntry("high.txt", `h${i}`);
    const link = symlinkEntry("link", "high.txt");
    const entries = [fileEntry("a.txt", "alpha"), high, link];
    for (const zip64 of [false, true]) {
      const report = await verify(entries, entries.map(recordFor), { zip64 });
      expect(report.summary.manifestMismatched).toBe(0);
      expect(report.reportOk).toBe(true);
    }
  });

  it.each([
    ["a size that is not a number", { size: "5" }],
    ["no CRC-32", { crc32: undefined }],
    ["no modification time", { mtime: undefined }],
    ["no archive path", { archivePath: undefined }],
    ["a malformed SHA-256", { sha256: "deadbeef" }],
  ])("rejects a manifest whose record has %s", async (_label, change) => {
    const a = fileEntry("a.txt", "alpha");
    await expect(verify([a], [{ ...recordFor(a), ...change }])).rejects.toMatchObject({
      code: "read.manifest-invalid",
    });
  });

  it("rejects a manifest that records one path twice or holds no entries list", async () => {
    const a = fileEntry("a.txt", "alpha");
    await expect(verify([a], [recordFor(a), recordFor(a)])).rejects.toMatchObject({
      code: "read.manifest-invalid",
    });
    const archive = await writeArchive([a, fileEntry("zipkit.json", JSON.stringify({ formatVersion: MANIFEST_FORMAT_VERSION }))]);
    await expect(new ZipKit().extract({ archive, dryRun: true, checkMetadata: true })).rejects.toMatchObject({
      code: "read.manifest-invalid",
    });
  });

  it("leaves a CRC-only verify unchanged", async () => {
    const a = fileEntry("a.txt", "alpha");
    const archive = await writeArchive([
      a,
      fileEntry("zipkit.json", JSON.stringify({ formatVersion: MANIFEST_FORMAT_VERSION, entries: [{ ...recordFor(a), size: 999 }] })),
    ]);
    const report = await new ZipKit().extract({ archive, dryRun: true });
    expect(report.reportOk).toBe(true);
    expect(report.summary.manifestMismatched).toBe(0);
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

  it("refuses to extract two entries in a directory that differ only by case", async () => {
    // A corrupt/hostile archive: `a/File.txt` and `a/file.txt` fold to one path on
    // a case-insensitive destination and would silently clobber each other. The
    // creation side already refuses such a pair; extraction fails loudly rather
    // than overwriting, before anything is written.
    const archive = await writeArchive([
      fileEntry("a/File.txt", "one"),
      fileEntry("a/file.txt", "two"),
    ]);
    const dest = path.join(dir, "out");
    await expect(new ZipKit().extract({ archive, dest })).rejects.toThrow(/colliding extraction targets/i);
    // Nothing was written for the colliding pair.
    await expect(stat(path.join(dest, "a", "File.txt"))).rejects.toThrow();
  });

  it("rejects a case-colliding archive in dry-run too (validation must match the real run)", async () => {
    // The GUI validates input with a dry-run before extracting, so a dry-run that
    // passes MUST guarantee the real run won't fail. A case-collision is a property
    // of the archive itself, not of the destination — so dry-run has to reject it
    // exactly as a real extraction does, or validation and execution would disagree.
    const archive = await writeArchive([
      fileEntry("a/File.txt", "one"),
      fileEntry("a/file.txt", "two"),
    ]);
    await expect(new ZipKit().extract({ archive, dryRun: true })).rejects.toThrow(/colliding extraction targets/i);
  });

  it.each([
    ["exact duplicate", [fileEntry("same.txt", "one"), fileEntry("same.txt", "two")]],
    ["normalized alias", [fileEntry("./same.txt", "one"), fileEntry("dir/../same.txt", "two")]],
    ["file ancestor", [fileEntry("a", "file"), fileEntry("a/b.txt", "child")]],
  ] as const)("rejects a %s target collision before writing", async (_label, entries) => {
    const archive = await writeArchive([...entries]);
    const dest = path.join(dir, "collision-out");

    await expect(new ZipKit().extract({ archive, dest })).rejects.toMatchObject({
      code: "read.target-collision",
    });
    await expect(stat(dest)).rejects.toThrow();
  });

  it("rejects a stream whose actual size differs from the central-directory declaration", async () => {
    const archive = await writeArchive([fileEntry("short.txt", "abc")]);
    const bytes = await readFile(archive);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThanOrEqual(0);
    bytes.writeUInt32LE(999, central + 24);
    await writeFile(archive, bytes);

    await expect(new ZipKit().extract({ archive, dryRun: true })).rejects.toMatchObject({
      code: "read.size-mismatch",
    });
  });

  it("never writes through a symlink whose target escapes the destination (symlink zip-slip)", async () => {
    // The classic symlink-indirected zip-slip: a symlink entry pointing OUTSIDE
    // the destination, then a file written "through" it. concurrency:1 forces the
    // worst case — the symlink entry is committed first, before the file.
    const outside = path.join(dir, "outside");
    await mkdir(outside, { recursive: true });
    const archive = await writeArchive([
      symlinkEntry("link", outside), // absolute target outside dest
      fileEntry("link/pwned.txt", "PWNED"),
    ]);
    const dest = path.join(dir, "out");

    await expect(new ZipKit({ concurrency: 1 }).extract({ archive, dest })).rejects.toMatchObject({
      code: "read.target-collision",
    });
    await expect(stat(path.join(outside, "pwned.txt"))).rejects.toThrow();
    await expect(stat(dest)).rejects.toThrow();
  });

  it.runIf(fileSymlinksSupported)("refuses a link that climbs back out through another restored link", async () => {
    // Each target passes alone: `x/s` points at dest itself, and `x/t`'s text
    // resolves inside dest. On disk `x/t` follows `s` to dest, then climbs past it.
    const archive = await writeArchive([
      symlinkEntry("x/s", ".."),
      symlinkEntry("x/t", "s/../../outside"),
      symlinkEntry("x/u", "../x/s/inside"),
    ]);
    const dest = path.join(dir, "chain");

    const report = await new ZipKit({ concurrency: 1 }).extract({ archive, dest });

    expect(report.entries.find((e) => e.archivePath === "x/t")?.skipped).toBe("unsafe");
    await expect(lstat(path.join(dest, "x", "t"))).rejects.toThrow();
    expect(await readlink(path.join(dest, "x", "s"))).toBe("..");
    // Climbing first and descending after stays allowed.
    expect(await readlink(path.join(dest, "x", "u"))).toBe("../x/s/inside");
  });

  it("refuses to write through a symlinked directory even when the link stays inside dest", async () => {
    // The link target is in-tree (no escape by itself), but writing an entry
    // *through* a symlinked directory is still refused — extraction never follows
    // a symlink it restored. concurrency:1 puts the symlink first.
    const archive = await writeArchive([
      symlinkEntry("ln", "real"), // relative, resolves inside dest
      fileEntry("ln/secret.txt", "x"),
    ]);
    const dest = path.join(dir, "out");

    await expect(new ZipKit({ concurrency: 1 }).extract({ archive, dest })).rejects.toMatchObject({
      code: "read.target-collision",
    });
    await expect(stat(dest)).rejects.toThrow();
  });

  it("aborts on a symlink-traversal entry when onUnsafe is abort", async () => {
    const outside = path.join(dir, "outside2");
    await mkdir(outside, { recursive: true });
    const archive = await writeArchive([
      symlinkEntry("link", outside),
      fileEntry("link/pwned.txt", "x"),
    ]);
    await expect(
      new ZipKit({ concurrency: 1 }).extract({
        archive,
        dest: path.join(dir, "out"),
        onUnsafe: "abort",
      }),
    ).rejects.toMatchObject({ code: "read.target-collision" });
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

  it("removes a staged temp file when the entry fails CRC verification", async () => {
    const archive = await writeArchive([fileEntry("bad.txt", "CORRUPTME")]);
    const bytes = await readFile(archive);
    const content = bytes.indexOf(Buffer.from("CORRUPTME"));
    expect(content).toBeGreaterThanOrEqual(0);
    bytes[content] = bytes[content]! ^ 0xff;
    await writeFile(archive, bytes);
    const dest = path.join(dir, "crc-out");

    const report = await new ZipKit().extract({ archive, dest });

    expect(report.entries[0]).toMatchObject({ crc: "fail", written: false, skipped: "crc-fail" });
    expect((await readdir(dest)).some((name) => name.startsWith(".zk-"))).toBe(false);
  });

  it("does not write a literally-excluded entry", async () => {
    const archive = await writeArchive([fileEntry("keep.txt", "k"), fileEntry("zipkit.json", "{}")]);
    const dest = path.join(dir, "out");
    const report = await new ZipKit().extract({
      archive,
      dest,
      exclude: [{ pattern: "zipkit.json", match: "literal", target: "both" }],
    });
    expect(report.entries.find((e) => e.archivePath === "zipkit.json")?.skipped).toBe("excluded");
    await expect(stat(path.join(dest, "zipkit.json"))).rejects.toThrow();
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

// POSIX permissions; Windows keeps only a read-only flag, which a replace cannot write through.
it.skipIf(process.platform === "win32")("keeps an existing file's permission mode when extraction overwrites it", async () => {
  const archive = await writeArchive([fileEntry("a.txt", "new")]);
  const dest = path.join(dir, "kept");
  await mkdir(dest);
  await writeFile(path.join(dest, "a.txt"), "old", { mode: 0o600 });

  await new ZipKit().extract({ archive, dest, overwrite: true });

  expect(await readFile(path.join(dest, "a.txt"), "utf8")).toBe("new");
  expect((await stat(path.join(dest, "a.txt"))).mode & 0o777).toBe(0o600);
});

// POSIX permissions; Windows keeps only a read-only flag.
it.skipIf(process.platform === "win32")("restores each new file's permission mode from the archive", async () => {
  const proj = path.join(dir, "proj");
  await mkdir(proj);
  await writeFile(path.join(proj, "tool.sh"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(path.join(proj, "secret.txt"), "private", { mode: 0o600 });
  const archive = path.join(dir, "modes.zip");
  await new ZipKit().create({ inputs: [proj], output: archive });

  const dest = path.join(dir, "modes");
  await new ZipKit().extract({ archive, dest });

  expect((await stat(path.join(dest, "tool.sh"))).mode & 0o777).toBe(0o755);
  expect((await stat(path.join(dest, "secret.txt"))).mode & 0o777).toBe(0o600);
});

describe("symlinks and zip64", () => {
  it("restores a symlink entry when supported and always honors symlinks: skip", async () => {
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

    const restore = new ZipKit().extract({ archive, dest: path.join(dir, "keep") });
    if (!fileSymlinksSupported) {
      await expect(restore).rejects.toMatchObject({ code: "read.write-failed" });
      return;
    }
    const restored = await restore;
    expect(restored.entries[0]?.written).toBe(true);
    expect(await readlink(path.join(dir, "keep", "link"))).toBe("target.txt");
  });

  it("stages each file in its own target folder, so publication never crosses a volume", async () => {
    const archive = await writeArchive([fileEntry("a/b/c.txt", "deep"), fileEntry("top.txt", "top")]);
    const dest = path.join(dir, "staged");
    const staged: string[] = [];
    const recording: FileSystemPort = {
      ...nodeFileSystem,
      open: (file, flags) => {
        if (flags === "wx") staged.push(file);
        return nodeFileSystem.open(file, flags);
      },
    };

    await extractArchive(
      { archive, dest },
      { limit: pLimit(2), logger: createLogger(), chunkSize: 65536, volume: new Volume(recording, 30_000) },
    );

    expect(staged.map((file) => path.dirname(file)).sort()).toEqual([dest, path.join(dest, "a", "b")].sort());
    expect(await readFile(path.join(dest, "a", "b", "c.txt"), "utf8")).toBe("deep");
    expect(await readdir(path.join(dest, "a", "b"))).toEqual(["c.txt"]);
  });

  it("leaves a file that already holds the entry's content as it is under overwrite", async () => {
    const archive = await writeArchive([fileEntry("same.txt", "content"), fileEntry("diff.txt", "content")]);
    const dest = path.join(dir, "unchanged");
    await mkdir(dest);
    await writeFile(path.join(dest, "same.txt"), "content");
    await writeFile(path.join(dest, "diff.txt"), "CONTENT");
    const same = await stat(path.join(dest, "same.txt"));
    const diff = await stat(path.join(dest, "diff.txt"));

    const report = await new ZipKit().extract({ archive, dest, overwrite: true });

    const byPath = Object.fromEntries(report.entries.map((e) => [e.archivePath, e]));
    expect(byPath["same.txt"]).toMatchObject({ written: false, skipped: "unchanged" });
    expect(byPath["diff.txt"]).toMatchObject({ written: true });
    expect((await stat(path.join(dest, "same.txt"))).ino).toBe(same.ino);
    expect((await stat(path.join(dest, "same.txt"))).mtimeMs).toBe(same.mtimeMs);
    expect((await stat(path.join(dest, "diff.txt"))).ino).not.toBe(diff.ino);
    expect(await readFile(path.join(dest, "diff.txt"), "utf8")).toBe("content");
    expect((await readdir(dest)).sort()).toEqual(["diff.txt", "same.txt"]);
  });

  it.runIf(fileSymlinksSupported)("leaves a symlink with the same target as it is under overwrite", async () => {
    const archive = await writeArchive([symlinkEntry("link", "target.txt")]);
    const dest = path.join(dir, "same-link");
    await mkdir(dest);
    await createFileLink("target.txt", path.join(dest, "link"));
    const before = await lstat(path.join(dest, "link"));

    const report = await new ZipKit().extract({ archive, dest, overwrite: true });

    expect(report.entries[0]).toMatchObject({ written: false, skipped: "unchanged" });
    expect((await lstat(path.join(dest, "link"))).ino).toBe(before.ino);
  });

  it("keeps an existing file when an overwriting symlink cannot be created", async () => {
    const archive = await writeArchive([symlinkEntry("link", "target.txt")]);
    const dest = path.join(dir, "refused");
    await mkdir(dest);
    await writeFile(path.join(dest, "link"), "original");
    const refusing: FileSystemPort = {
      ...nodeFileSystem,
      symlink: () => Promise.reject(Object.assign(new Error("symlink refused"), { code: "EPERM" })),
    };

    await expect(
      extractArchive(
        { archive, dest, overwrite: true },
        { limit: pLimit(1), logger: createLogger(), chunkSize: 65536, volume: new Volume(refusing, 30_000) },
      ),
    ).rejects.toMatchObject({ code: "read.write-failed" });
    expect(await readFile(path.join(dest, "link"), "utf8")).toBe("original");
    expect(await readdir(dest)).toEqual(["link"]);
  });

  it.runIf(fileSymlinksSupported)("replaces an existing file with a restored symlink under overwrite", async () => {
    const archive = await writeArchive([symlinkEntry("link", "target.txt")]);
    const dest = path.join(dir, "replaced");
    await mkdir(dest);
    await writeFile(path.join(dest, "link"), "original");

    const report = await new ZipKit().extract({ archive, dest, overwrite: true });
    expect(report.entries[0]?.written).toBe(true);
    expect(await readlink(path.join(dest, "link"))).toBe("target.txt");
    expect(await readdir(dest)).toEqual(["link"]);
  });

  it("rejects an oversized symlink target before buffering its decompressed bytes", async () => {
    const archive = await writeArchive([symlinkEntry("huge-link", "x".repeat(70 * 1024))]);

    await expect(new ZipKit().extract({ archive, dryRun: true })).rejects.toMatchObject({
      code: "read.entry-too-large",
    });
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

describe("EOCD-locator robustness", () => {
  it("reads an archive whose comment embeds the EOCD signature", async () => {
    // The EOCD is found by scanning the archive tail for its 4-byte signature; a
    // comment that embeds those same bytes must not be mistaken for the real
    // record. The comment-length validation in the locator is what prevents it.
    const src = path.join(dir, "csrc");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "a.txt"), "hello");
    const archive = path.join(dir, "commented.zip");
    // The 4-byte EOCD signature (PK\x05\x06), built from char codes so the
    // control bytes are explicit in the source rather than invisible, then
    // padded so the embedded copy sits far enough from EOF to be scanned as a
    // candidate ahead of the real record.
    const eocdSig = String.fromCharCode(0x50, 0x4b, 0x05, 0x06);
    const comment = `${eocdSig}${"X".repeat(40)}`;
    await new ZipKit().create({ inputs: [src], output: archive, overwrite: true, comment });

    const report = await new ZipKit().extract({ archive, dryRun: true });
    expect(report.reportOk).toBe(true);
    expect(report.entries.find((e) => e.archivePath === "a.txt")?.crc).toBe("ok");
  });

  it("reads Zip64 metadata even when a maximum-length comment pushes it beyond the EOCD tail", async () => {
    const archive = await writeArchive([fileEntry("z.txt", "zip64")], {
      zip64: true,
      comment: "x".repeat(0xffff),
    });
    const bytes = await readFile(archive);
    const eocd = bytes.length - 0xffff - 22;
    // Force the classic record to defer directory identity to Zip64. The writer
    // emits real small values when Zip64 was test-forced, so without these
    // sentinels a reader is allowed to ignore the Zip64 records entirely.
    bytes.writeUInt16LE(0xffff, eocd + 8);
    bytes.writeUInt16LE(0xffff, eocd + 10);
    bytes.writeUInt32LE(0xffffffff, eocd + 16);
    await writeFile(archive, bytes);

    const report = await new ZipKit().extract({ archive, dryRun: true });
    expect(report.reportOk).toBe(true);
    expect(report.entries[0]).toMatchObject({ archivePath: "z.txt", crc: "ok" });
  });
});

describe("large-file streaming round-trip", () => {
  it("round-trips a file many chunks long through create then extract with a matching SHA", async () => {
    // 256 KiB of pseudo-random (incompressible) plus compressible content under a
    // 4 KiB chunk size, so the streaming read/deflate/write and the streaming
    // inflate/write both span well over a hundred chunks.
    const chunkSize = 4096;
    const src = path.join(dir, "src");
    await rm(src, { recursive: true, force: true });
    const big = Buffer.concat([
      randomBytes(32 * chunkSize), // incompressible
      Buffer.from("compress me ".repeat(10_000), "utf8"), // deflate wins here
    ]);
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "big.bin"), big);
    const expectedSha = createHash("sha256").update(big).digest("hex");

    const archive = path.join(dir, "big.zip");
    await new ZipKit({ chunkSize }).create({ inputs: [src], output: archive, overwrite: true });

    const dest = path.join(dir, "big-out");
    const report = await new ZipKit({ chunkSize }).extract({ archive, dest });
    expect(report.reportOk).toBe(true);
    const roundTripped = await readFile(path.join(dest, "big.bin"));
    expect(createHash("sha256").update(roundTripped).digest("hex")).toBe(expectedSha);
  });

  it("honors a small chunkSize for both create and extract", async () => {
    const src = path.join(dir, "csrc");
    await mkdir(src, { recursive: true });
    const content = Buffer.from("chunked streaming ".repeat(500), "utf8");
    await writeFile(path.join(src, "c.txt"), content);

    const archive = path.join(dir, "chunked.zip");
    // A tiny chunk size forces over a hundred read/deflate/write cycles per entry.
    await new ZipKit({ chunkSize: 64 }).create({ inputs: [src], output: archive, overwrite: true });
    const dest = path.join(dir, "chunked-out");
    const report = await new ZipKit({ chunkSize: 64 }).extract({ archive, dest });
    expect(report.reportOk).toBe(true);
    expect((await readFile(path.join(dest, "c.txt"))).equals(content)).toBe(true);
  });
});

describe("per-failure logging", () => {
  /** Parse the lone session log under `logDir` into its JSONL event objects. */
  async function sessionEvents(logDir: string): Promise<Array<Record<string, unknown>>> {
    const files = (await readdir(logDir)).filter((f) => f.endsWith(".log"));
    expect(files).toHaveLength(1);
    return (await readFile(path.join(logDir, files[0]!), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("emits an error line per CRC failure and unsafe path, naming each failed entry", async () => {
    // One archive, three fates: a clean entry, a CRC-corrupted entry, and a
    // zip-slip entry. The clean one stays silent (its only line is the
    // debug-gated entry.verified); the two failures must each surface a line.
    const archive = await writeArchive([
      fileEntry("good.txt", "intact"),
      fileEntry("bad.txt", "CORRUPTME"),
      fileEntry("../evil.txt", "pwned"),
    ]);
    const buf = await readFile(archive);
    const idx = buf.indexOf(Buffer.from("CORRUPTME"));
    buf[idx] = buf[idx]! ^ 0xff;
    await writeFile(archive, buf);

    const logDir = path.join(dir, "logs-crc");
    const report = await new ZipKit({ logDir }).extract({ archive, dest: path.join(dir, "out") });
    expect(report.reportOk).toBe(false);

    const events = await sessionEvents(logDir);
    const flagged = events.filter((e) => e.event === "entry.flagged");

    expect(flagged.find((e) => e.rule === "extract.crc-fail")).toMatchObject({
      stage: "extract",
      level: "error",
      severity: "error",
      path: "bad.txt",
    });
    expect(flagged.find((e) => e.rule === "extract.unsafe-path")).toMatchObject({
      stage: "extract",
      level: "error",
      severity: "error",
      path: "../evil.txt",
    });
    // The intact entry produced no warn/error line...
    expect(flagged.some((e) => e.path === "good.txt")).toBe(false);
    // ...and the per-failure lines precede the surviving aggregate.
    const doneIndex = events.findIndex((e) => e.event === "extract.done");
    const lastFlagged = events.map((e) => e.event).lastIndexOf("entry.flagged");
    expect(doneIndex).toBeGreaterThan(lastFlagged);
  });

  it("emits error lines for SHA mismatch and missing entries and a warn line for an extra entry", async () => {
    // The embedded manifest claims a.txt with a WRONG sha (→ mismatch) and a
    // phantom c.txt (→ missing), and omits the real b.txt (→ extra).
    const manifest = {
      formatVersion: MANIFEST_FORMAT_VERSION,
      entries: [
        manifestRecord(fileEntry("a.txt", "alpha"), createHash("sha256").update("not-alpha").digest("hex")),
        manifestRecord(fileEntry("c.txt", "gamma"), "de".repeat(32)),
      ],
    };
    const archive = await writeArchive([
      fileEntry("a.txt", "alpha"),
      fileEntry("b.txt", "beta"),
      fileEntry("zipkit.json", JSON.stringify(manifest)),
    ]);

    const logDir = path.join(dir, "logs-meta");
    const report = await new ZipKit({ logDir }).extract({
      archive,
      dryRun: true,
      checkMetadata: true,
    });
    expect(report.reportOk).toBe(false);

    const flagged = (await sessionEvents(logDir)).filter((e) => e.event === "entry.flagged");
    expect(flagged.find((e) => e.rule === "extract.sha-mismatch")).toMatchObject({
      stage: "extract",
      level: "error",
      severity: "error",
      path: "a.txt",
    });
    expect(flagged.find((e) => e.rule === "extract.missing")).toMatchObject({
      stage: "extract",
      level: "error",
      severity: "error",
      path: "c.txt",
    });
    expect(flagged.find((e) => e.rule === "extract.extra")).toMatchObject({
      stage: "extract",
      level: "warn",
      severity: "warning",
      path: "b.txt",
    });
  });
});
