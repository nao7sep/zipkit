/**
 * Verification tests. Archives are built with the streaming in-house writer
 * into a temp dir, then read back through the public `verify` operation. Covers
 * CRC-32 and SHA-256 checks, entries whose data cannot be read, completeness
 * against the manifest, and Zip64.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipKit } from "../../src/index.ts";
import { MANIFEST_FORMAT_VERSION } from "../../src/write/manifest.ts";
import { buildZipFile, type BuildOptions, type EntryWithData } from "../helpers/writeZip.ts";

const Y2020_NS = 1_577_836_800_000_000_000n;

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
  dir = await mkdtemp(path.join(os.tmpdir(), "zk-verify-"));
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

/** Flip the first byte of `marker` in the archive, so its stored CRC-32 no longer matches. */
async function corrupt(archive: string, marker: string): Promise<void> {
  const buf = await readFile(archive);
  const idx = buf.indexOf(Buffer.from(marker));
  buf[idx] = buf[idx]! ^ 0xff;
  await writeFile(archive, buf);
}

/** Set the first central record's 32-bit field at `offset` (24 is the uncompressed size). */
async function patchCentral(archive: string, offset: number, value: number, width: 2 | 4 = 4): Promise<void> {
  const bytes = await readFile(archive);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  expect(central).toBeGreaterThanOrEqual(0);
  if (width === 4) bytes.writeUInt32LE(value, central + offset);
  else bytes.writeUInt16LE(value, central + offset);
  await writeFile(archive, bytes);
}

describe("integrity on any zip", () => {
  it("verifies every entry's CRC-32 and writes nothing", async () => {
    const archive = await writeArchive([fileEntry("a.txt", "x"), fileEntry("b.txt", "y")]);
    const before = await readdir(dir);
    const report = await new ZipKit().verify(archive);
    expect(report.ok).toBe(true);
    expect(report.manifest).toBeNull();
    expect(report.entries.every((e) => e.crc32 === "ok" && e.sha256 === undefined)).toBe(true);
    expect(await readdir(dir)).toEqual(before);
  });

  it("reports a CRC failure as a finding, not an error", async () => {
    // The streaming writer computes a correct CRC, so corruption is introduced after the fact.
    const archive = await writeArchive([fileEntry("bad.txt", "payload"), fileEntry("good.txt", "fine")]);
    await corrupt(archive, "payload");
    const report = await new ZipKit().verify(archive);
    expect(report.ok).toBe(false);
    expect(report.summary.crc32Failed).toBe(1);
    expect(report.entries.find((e) => e.archivePath === "bad.txt")?.crc32).toBe("fail");
    expect(report.entries.find((e) => e.archivePath === "good.txt")?.crc32).toBe("ok");
    expect(report.findings).toEqual([expect.objectContaining({ rule: "verify.crc32-mismatch", path: "bad.txt", severity: "error" })]);
  });

  it("reports an entry whose data disagrees with its declared size, and verifies the rest", async () => {
    const archive = await writeArchive([fileEntry("short.txt", "abc"), fileEntry("other.txt", "fine")]);
    await patchCentral(archive, 24, 999);
    const report = await new ZipKit().verify(archive);
    expect(report.ok).toBe(false);
    expect(report.summary.unreadable).toBe(1);
    expect(report.entries.find((e) => e.archivePath === "short.txt")?.crc32).toBe("unreadable");
    expect(report.entries.find((e) => e.archivePath === "other.txt")?.crc32).toBe("ok");
    expect(report.findings.map((f) => [f.rule, f.path])).toContainEqual(["verify.unreadable", "short.txt"]);
  });

  it("reports an entry stored with a method ZipKit cannot read", async () => {
    const archive = await writeArchive([fileEntry("odd.bin", "data")]);
    await patchCentral(archive, 10, 12, 2); // bzip2
    const report = await new ZipKit().verify(archive);
    expect(report.ok).toBe(false);
    expect(report.entries[0]?.crc32).toBe("unreadable");
    expect(report.findings[0]).toMatchObject({ rule: "verify.unreadable", path: "odd.bin" });
  });

  it("fails as a whole only when the file is not a zip", async () => {
    const archive = path.join(dir, "not.zip");
    await writeFile(archive, "plain text, not an archive");
    await expect(new ZipKit().verify(archive)).rejects.toMatchObject({ code: "archive.not-zip", kind: "invalid" });
    await expect(new ZipKit().verify(path.join(dir, "absent.zip"))).rejects.toMatchObject({ code: "path.missing", kind: "unavailable" });
  });

  it("verifies a zero-byte file and a Zip64 archive", async () => {
    expect((await new ZipKit().verify(await writeArchive([fileEntry("empty.txt", ""), fileEntry("a.txt", "x")]))).ok).toBe(true);
    expect((await new ZipKit().verify(await writeArchive([fileEntry("z.txt", "zip64 content")], { zip64: true }))).ok).toBe(true);
  });
});

describe("against the embedded manifest", () => {
  it("reads a manifest whatever size it declares, refusing data that disagrees with it", async () => {
    const archive = await writeArchive([fileEntry("zipkit.json", JSON.stringify({ formatVersion: MANIFEST_FORMAT_VERSION, entries: [] }))]);
    await patchCentral(archive, 24, 64 * 1024 * 1024 + 1);
    await expect(new ZipKit().verify(archive, { manifest: true })).rejects.toMatchObject({ code: "archive.size-mismatch" });
  });

  it.each(["file", "symlink", "dir"] as const)("fails a %s entry whose manifest records a different type", async (type) => {
    const entry = type === "dir"
      ? { ...fileEntry("folder", ""), type, mode: 0o40755 }
      : { ...fileEntry("link", "target.txt"), type, mode: type === "symlink" ? 0o120777 : 0o644 };
    const record = { ...manifestRecord(entry), type: type === "file" ? "symlink" : "file" };
    const archive = await writeArchive([entry, fileEntry("zipkit.json", JSON.stringify({ formatVersion: MANIFEST_FORMAT_VERSION, entries: [record] }))]);
    const report = await new ZipKit().verify(archive, { manifest: true });
    expect(report.ok).toBe(false);
    expect(report.summary.manifestMismatched).toBe(1);
  });

  it("verifies SDK-created directory records with their original filesystem sizes", async () => {
    const input = path.join(dir, "input");
    await mkdir(path.join(input, "empty"), { recursive: true });
    await mkdir(path.join(input, "occupied"));
    await writeFile(path.join(input, "occupied", "file.txt"), "content");
    const kit = new ZipKit();
    const archive = path.join(dir, "created.zip");
    await kit.create({ inputs: [input], output: archive, policy: { manifest: { name: "zipkit.json", hash: true } } });
    const report = await kit.verify(archive, { manifest: true });
    expect(report.ok).toBe(true);
    expect(report.summary.manifestMismatched).toBe(0);
    expect(report.entries.filter((entry) => entry.type === "dir").length).toBeGreaterThanOrEqual(2);
  });

  it("verifies SHA-256 and reports missing and extra entries", async () => {
    const aData = Buffer.from("alpha", "utf8");
    // The manifest claims a.txt (real sha) and a phantom c.txt, and omits the real b.txt.
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

    const report = await new ZipKit().verify(archive, { manifest: true });
    expect(report.manifest?.name).toBe("zipkit.json");
    expect(report.entries.find((e) => e.archivePath === "a.txt")?.sha256).toBe("ok");
    expect(report.entries.find((e) => e.archivePath === "b.txt")?.sha256).toBe("absent");
    expect(report.missing).toEqual(["c.txt"]);
    expect(report.extra).toEqual(["b.txt"]);
    expect(report.ok).toBe(false);
  });

  it("looks for the manifest under the instance policy's name unless the call names another", async () => {
    await writeFile(path.join(dir, "f.txt"), "one");
    const archive = path.join(dir, "named.zip");
    const policy = { manifest: { name: "record.json" } };
    await new ZipKit({ policy }).create({ inputs: [path.join(dir, "f.txt")], output: archive });
    expect((await new ZipKit({ policy }).verify(archive, { manifest: true })).manifest).toEqual({ name: "record.json" });
    expect((await new ZipKit().verify(archive, { manifest: true, manifestName: "record.json" })).ok).toBe(true);
    await expect(new ZipKit().verify(archive, { manifest: true })).rejects.toMatchObject({ code: "manifest.missing", subject: "zipkit.json" });
  });

  it("refuses a manifest a newer ZipKit wrote, leaving the archive as it is", async () => {
    const manifest = { formatVersion: MANIFEST_FORMAT_VERSION + 1, entries: [{ archivePath: "a.txt" }] };
    const archive = await writeArchive([fileEntry("a.txt", "alpha"), fileEntry("zipkit.json", JSON.stringify(manifest))]);
    const before = await readFile(archive);
    await expect(new ZipKit().verify(archive, { manifest: true })).rejects.toMatchObject({ kind: "invalid", code: "manifest.newer" });
    expect((await readFile(archive)).equals(before)).toBe(true);
  });

  it.each([undefined, 0, 1.5, "1"])("rejects a manifest without a positive integer format version: %j", async (formatVersion) => {
    const archive = await writeArchive([
      fileEntry("a.txt", "alpha"),
      fileEntry("zipkit.json", JSON.stringify({ formatVersion, entries: [{ archivePath: "a.txt" }] })),
    ]);
    await expect(new ZipKit().verify(archive, { manifest: true })).rejects.toMatchObject({ code: "manifest.invalid" });
  });

  it("validates a manifest end to end via create()", async () => {
    await writeFile(path.join(dir, "f1.txt"), "one");
    await writeFile(path.join(dir, "f2.txt"), "two");
    const archive = path.join(dir, "made.zip");
    await new ZipKit().create({
      inputs: [path.join(dir, "f1.txt"), path.join(dir, "f2.txt")],
      output: archive,
      policy: { manifest: { name: "zipkit.json", hash: true } },
    });
    const report = await new ZipKit().verify(archive, { manifest: true });
    expect(report.manifest?.name).toBe("zipkit.json");
    expect(report.ok).toBe(true);
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
    return new ZipKit().verify(archive, { manifest: true });
  }

  it("fails an entry whose size differs from the manifest", async () => {
    const a = fileEntry("a.txt", "alpha");
    const report = await verify([a], [{ ...recordFor(a), size: 999 }]);
    expect(report.ok).toBe(false);
    expect(report.summary.manifestMismatched).toBe(1);
    expect(report.findings.filter((f) => f.rule === "verify.manifest-mismatch")).toEqual([
      expect.objectContaining({ path: "a.txt", severity: "error" }),
    ]);
  });

  it("fails an entry whose CRC-32 differs from the manifest even with no SHA-256 recorded", async () => {
    const a = fileEntry("a.txt", "alpha");
    const report = await verify([a], [{ ...recordFor(a), crc32: (crc32(a.raw) + 1) >>> 0 }]);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.rule)).toContain("verify.manifest-mismatch");
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
      expect(report.ok).toBe(true);
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
    await expect(verify([a], [{ ...recordFor(a), ...change }])).rejects.toMatchObject({ code: "manifest.invalid" });
  });

  it("rejects a manifest that records one path twice or holds no entries list", async () => {
    const a = fileEntry("a.txt", "alpha");
    await expect(verify([a], [recordFor(a), recordFor(a)])).rejects.toMatchObject({ code: "manifest.invalid" });
    const archive = await writeArchive([a, fileEntry("zipkit.json", JSON.stringify({ formatVersion: MANIFEST_FORMAT_VERSION }))]);
    await expect(new ZipKit().verify(archive, { manifest: true })).rejects.toMatchObject({ code: "manifest.invalid" });
  });

  it("ignores the manifest without `manifest`", async () => {
    const a = fileEntry("a.txt", "alpha");
    const archive = await writeArchive([
      a,
      fileEntry("zipkit.json", JSON.stringify({ formatVersion: MANIFEST_FORMAT_VERSION, entries: [{ ...recordFor(a), size: 999 }] })),
    ]);
    const report = await new ZipKit().verify(archive);
    expect(report.ok).toBe(true);
    expect(report.summary.manifestMismatched).toBe(0);
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
    await new ZipKit().create({ inputs: [src], output: archive, comment });

    const report = await new ZipKit().verify(archive);
    expect(report.ok).toBe(true);
    expect(report.entries.find((e) => e.archivePath === "a.txt")?.crc32).toBe("ok");
  });

  it("reads Zip64 records even when a maximum-length comment pushes them beyond the EOCD tail", async () => {
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

    const report = await new ZipKit().verify(archive);
    expect(report.ok).toBe(true);
    expect(report.entries[0]).toMatchObject({ archivePath: "z.txt", crc32: "ok" });
  });
});

describe("large-file streaming", () => {
  it.each([4096, 64])("verifies a file many chunks long against its SHA-256 at chunk size %i", async (chunkSize) => {
    const src = path.join(dir, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "big.bin"), Buffer.concat([
      randomBytes(8 * 4096), // incompressible
      Buffer.from("compress me ".repeat(2_000), "utf8"), // deflate wins here
    ]));
    const archive = path.join(dir, "big.zip");
    await new ZipKit({ chunkSize }).create({ inputs: [src], output: archive });

    const report = await new ZipKit({ chunkSize }).verify(archive, { manifest: true });
    expect(report.ok).toBe(true);
    expect(report.entries.find((e) => e.archivePath === "big.bin")?.sha256).toBe("ok");
  });
});

describe("per-failure logging", () => {
  /** Run `verify` and collect what reaches its `onEvent`, as plain data. */
  async function verifyWithEvents(archive: string, manifest: boolean) {
    const events: Array<Record<string, unknown>> = [];
    const report = await new ZipKit().verify(archive, { manifest, onEvent: (e) => events.push({ ...e }) });
    return { report, events };
  }

  it("emits an error line per CRC failure and unreadable entry, naming each failed entry", async () => {
    // Three fates: a clean entry, a CRC-corrupted entry, and an entry whose data
    // is shorter than declared. The clean one stays silent (its only line is the
    // debug-gated entry.verified); the two failures must each surface a line.
    const archive = await writeArchive([
      fileEntry("short.txt", "abc"),
      fileEntry("good.txt", "intact"),
      fileEntry("bad.txt", "CORRUPTME"),
    ]);
    await corrupt(archive, "CORRUPTME");
    await patchCentral(archive, 24, 999);

    const { report, events } = await verifyWithEvents(archive, false);
    expect(report.ok).toBe(false);

    const flagged = events.filter((e) => e.event === "entry.flagged");

    expect(flagged.find((e) => e.rule === "verify.crc32-mismatch")).toMatchObject({
      stage: "verify",
      level: "error",
      severity: "error",
      path: "bad.txt",
    });
    expect(flagged.find((e) => e.rule === "verify.unreadable")).toMatchObject({
      stage: "verify",
      level: "error",
      severity: "error",
      path: "short.txt",
    });
    // The intact entry produced no warn/error line...
    expect(flagged.some((e) => e.path === "good.txt")).toBe(false);
    // ...and the per-failure lines precede the aggregate.
    const doneIndex = events.findIndex((e) => e.event === "verify.done");
    const lastFlagged = events.map((e) => e.event).lastIndexOf("entry.flagged");
    expect(doneIndex).toBeGreaterThan(lastFlagged);
  });

  it("emits error lines for SHA mismatch and missing entries and a warn line for an extra entry", async () => {
    // The manifest claims a.txt with a WRONG sha (→ mismatch) and a phantom
    // c.txt (→ missing), and omits the real b.txt (→ extra).
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

    const { report, events } = await verifyWithEvents(archive, true);
    expect(report.ok).toBe(false);

    const flagged = events.filter((e) => e.event === "entry.flagged");
    expect(flagged.find((e) => e.rule === "verify.sha256-mismatch")).toMatchObject({
      stage: "verify",
      level: "error",
      severity: "error",
      path: "a.txt",
    });
    expect(flagged.find((e) => e.rule === "verify.missing")).toMatchObject({
      stage: "verify",
      level: "error",
      severity: "error",
      path: "c.txt",
    });
    expect(flagged.find((e) => e.rule === "verify.extra")).toMatchObject({
      stage: "verify",
      level: "warn",
      severity: "warning",
      path: "b.txt",
    });
  });
});
