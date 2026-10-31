/**
 * Manifest builder. Locks the lossless symlink classification, the four UTC
 * times (and the btime-null sentinel), and the optional archive comment.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, resolvePolicy } from "../../src/policy.ts";
import { buildManifest, excludedRecords } from "../../src/write/manifest.ts";
import { VERSION } from "../../src/version.ts";
import type { ManifestEntryInput } from "../../src/write/manifest.ts";
import { estimateManifestSize } from "../../src/plan/zip64.ts";
import type { ManifestContent } from "../../src/plan/zip64.ts";
import type { WriteEntry } from "../../src/internal/types.ts";
import type { Finding, PlanData, PlannedEntry } from "../../src/types.ts";

const plan: PlanData = {
  mode: "plan",
  output: "out.zip",
  writable: true,
  summary: { total: 1, included: 1, excluded: 0, renamed: 0, warnings: 0, errors: 0, zip64: false, sourceBytes: 0 },
  findings: [],
  entries: [],
  instructions: { output: "/out.zip", writable: true, zip64: false, policy: resolvePolicy(undefined, {}), overwrite: false, timeZone: "UTC", entries: [] },
};

const symlink: WriteEntry = {
  archivePath: "link",
  originalPath: "link",
  sourcePath: "link",
  type: "symlink",
  method: "store",
  absolutePath: "",
  size: 6,
  mtimeNs: 1_577_836_800_000_000_000n,
  atimeNs: 1_577_836_800_000_000_000n,
  ctimeNs: 1_577_836_800_000_000_000n,
  birthtimeNs: 1_577_836_800_000_000_000n,
  mode: 0o120777,
  nameFixes: [],
  linkTarget: "target",
};

const dirEntry: WriteEntry = {
  archivePath: "emptydir",
  originalPath: "emptydir",
  sourcePath: "emptydir",
  type: "dir",
  method: "store",
  absolutePath: "",
  size: 0,
  mtimeNs: 0n,
  atimeNs: 0n,
  ctimeNs: 0n,
  birthtimeNs: 0n,
  mode: 0,
  nameFixes: [],
};

function fileAt(archivePath: string, mtimeNs: bigint): WriteEntry {
  return {
    archivePath,
    originalPath: archivePath,
    sourcePath: archivePath,
    type: "file",
    method: "deflate",
    absolutePath: `/abs/${archivePath}`,
    size: 10,
    mtimeNs,
    atimeNs: mtimeNs,
    ctimeNs: mtimeNs,
    birthtimeNs: mtimeNs,
    mode: 0o644,
    nameFixes: [],
  };
}

function metaEntries(doc: { entries: unknown }): Array<Record<string, unknown>> {
  return doc.entries as Array<Record<string, unknown>>;
}

describe("buildManifest", () => {
  it("records a symlink's classification and all four UTC times losslessly", () => {
    const doc = buildManifest(plan, DEFAULT_POLICY, [{ writeEntry: symlink, crc32: 123, compressedSize: 6 }], { createdNs: 0n, timeZone: "Asia/Tokyo" });
    const entry = metaEntries(doc)[0]!;
    expect(entry.type).toBe("symlink");
    expect(doc.createdAtUtc).toBeDefined();
    expect(doc.timeZone).toBe("Asia/Tokyo");
    // Each time is recorded as lossless ns plus an ISO-8601 string, in UTC.
    expect(entry.mtime).toEqual({ ns: "1577836800000000000", iso: "2020-01-01T00:00:00.000Z" });
    for (const key of ["mtime", "atime", "ctime", "btime"]) {
      expect((entry[key] as { ns: string }).ns).toBe("1577836800000000000");
    }
  });

  it("opens with the format header, then what the document is, where its SDK lives and when it was made", () => {
    const doc = buildManifest(plan, DEFAULT_POLICY, [], { createdNs: 0n, timeZone: "UTC", caller: { name: "zipkit", version: "1.2.3" } });
    expect(Object.keys(doc).slice(0, 5)).toEqual(["format", "writer", "about", "repository", "createdAtUtc"]);
    expect(doc.format).toEqual({ owner: "zipkit", kind: "manifest", version: 1 });
    expect(doc.writer).toEqual({ name: "zipkitsdk", version: VERSION, caller: { name: "zipkit", version: "1.2.3" } });
    expect(doc.about).toMatch(/^zipkitsdk wrote this manifest/);
    expect(doc.about).not.toContain("ZipKit");
    expect(doc.repository).toBe("https://github.com/nao7sep/zipkit");
    expect(doc.createdAtUtc).toEqual({ ns: "0", iso: "1970-01-01T00:00:00.000Z" });
    // No caller named, none recorded.
    expect(buildManifest(plan, DEFAULT_POLICY, [], { createdNs: 0n, timeZone: "UTC" }).writer).toEqual({ name: "zipkitsdk", version: VERSION });
  });

  it("records the time zone once and exclusion patterns by id and text, never by note", () => {
    const policy = resolvePolicy(undefined, { timeZone: "Asia/Tokyo" });
    const doc = buildManifest(plan, policy, [], { createdNs: 0n, timeZone: "Asia/Tokyo" });
    expect(doc.timeZone).toBe("Asia/Tokyo");
    expect(doc.policy).not.toHaveProperty("timeZone");
    expect(doc.policy.exclusions[0]).toEqual({ id: "macos.ds-store", pattern: ".DS_Store", match: "glob", target: "both", ignoreCase: true });
    expect(JSON.stringify(doc)).not.toContain("Finder");
  });

  it("records btime as null when the platform reports no creation time", () => {
    const noBirth: WriteEntry = { ...symlink, birthtimeNs: 0n };
    const doc = buildManifest(plan, DEFAULT_POLICY, [{ writeEntry: noBirth, crc32: 123, compressedSize: 6 }], { createdNs: 0n, timeZone: "UTC" });
    const entry = metaEntries(doc)[0]!;
    expect(entry.btime).toBeNull();
    // The reliable times are still present.
    expect((entry.mtime as { ns: string }).ns).toBe("1577836800000000000");
  });

  it("records the archive comment when one is given", () => {
    const doc = buildManifest(plan, DEFAULT_POLICY, [{ writeEntry: symlink, crc32: 0, compressedSize: 6 }], { createdNs: 0n, timeZone: "UTC", comment: "release build" });
    expect(doc.comment).toBe("release build");
  });

  it("omits the comment field entirely when none is given", () => {
    const doc = buildManifest(plan, DEFAULT_POLICY, [{ writeEntry: symlink, crc32: 0, compressedSize: 6 }], { createdNs: 0n, timeZone: "UTC" });
    expect("comment" in doc).toBe(false);
  });
});

describe("timeRange", () => {
  it("is null when the archive has only directory entries (no file to date)", () => {
    const doc = buildManifest(plan, DEFAULT_POLICY, [{ writeEntry: dirEntry, crc32: 0, compressedSize: 0 }], { createdNs: 0n, timeZone: "UTC" });
    expect(doc.timeRange).toBeNull();
  });

  it("spans the oldest and newest non-directory entries by mtime, ignoring directories", () => {
    const old = 1_000_000_000_000_000_000n;
    const mid = 1_500_000_000_000_000_000n;
    const recent = 2_000_000_000_000_000_000n;
    const doc = buildManifest(plan, DEFAULT_POLICY, [
        { writeEntry: fileAt("mid.txt", mid), crc32: 0, compressedSize: 5 },
        { writeEntry: fileAt("old.txt", old), crc32: 0, compressedSize: 5 },
        { writeEntry: fileAt("new.txt", recent), crc32: 0, compressedSize: 5 },
        // A directory whose mtime predates every file must not become the oldest.
        { writeEntry: dirEntry, crc32: 0, compressedSize: 0 },
      ], { createdNs: 0n, timeZone: "UTC" });
    expect(doc.timeRange).not.toBeNull();
    expect(doc.timeRange?.oldest.archivePath).toBe("old.txt");
    expect(doc.timeRange?.newest.archivePath).toBe("new.txt");
    expect(doc.timeRange?.oldest.mtime.ns).toBe(old.toString());
    expect(doc.timeRange?.newest.mtime.ns).toBe(recent.toString());
  });
});

describe("estimateManifestSize (Zip64 manifest bound)", () => {
  it("upper-bounds a real serialized manifest with long paths, many findings, and a comment", () => {
    const longPath = `deep/${"x".repeat(180)}/file.txt`;
    const base: WriteEntry = {
      archivePath: "",
      originalPath: "",
      sourcePath: "",
      type: "file",
      method: "deflate",
      absolutePath: "/abs/x",
      size: 1234,
      mtimeNs: 1_577_836_800_000_000_000n,
      atimeNs: 1_577_836_800_000_000_000n,
      ctimeNs: 1_577_836_800_000_000_000n,
      birthtimeNs: 1_577_836_800_000_000_000n,
      mode: 0o644,
      nameFixes: [],
    };
    const writeEntries: WriteEntry[] = [
      {
        ...base,
        archivePath: longPath,
        originalPath: `${longPath}.orig`,
        sourcePath: `input/${longPath}`,
        // A non-NFC rename nameFix, itself carrying full paths.
        nameFixes: [{ rule: "name.nfd", before: `${longPath}A`, after: longPath }],
      },
      {
        ...base,
        archivePath: `link-${"y".repeat(120)}`,
        originalPath: `link-${"y".repeat(120)}`,
        sourcePath: `input/link-${"y".repeat(120)}`,
        type: "symlink",
        method: "store",
        linkTarget: "t".repeat(140),
      },
    ];

    const excludedPlanned: PlannedEntry = {
      archivePath: `excluded/${"z".repeat(160)}`,
      originalPath: `excluded/${"z".repeat(160)}`,
      diskPath: `/in/excluded/${"z".repeat(160)}`,
      type: "file",
      method: "store",
      excluded: true,
      excludeCode: "pattern",
      excludeReason: "pattern .DS_Store",
      excludedBy: { id: "x".repeat(60), pattern: `**/${"p".repeat(120)}` },
      nameFixes: [],
      findings: [],
    };

    // Many findings, with a control character to exercise worst-case JSON escaping.
    const findings: Finding[] = Array.from({ length: 40 }, (_, i) => ({
      id: `name.invalid-char:path/${i}/${"w".repeat(80)}`,
      rule: "name.invalid-char",
      severity: "info",
      path: `path/${i}/${"w".repeat(80)}`,
      message: "replaced an invalid character with a control \u0001 char",
      fix: { kind: "rename", to: `fixed-${i}` },
    }));

    const comment = "release \u0002 build ".repeat(50);

    const policy = resolvePolicy(undefined, {
      exclusions: [
        { id: "x".repeat(60), pattern: `**/${"p".repeat(120)}`, match: "glob", target: "both", ignoreCase: false, note: "l".repeat(40) },
        { pattern: "a".repeat(90), match: "regex", target: "file", ignoreCase: true },
      ],
      compression: { store: [".aaa", ".bbb", ".ccc"] },
      timeZone: "Asia/Tokyo",
    });

    const planDoc: PlanData = {
      mode: "plan",
      output: "out.zip",
      writable: true,
      // Max-width summary numbers: their exact values don't matter for the bound.
      summary: { total: 99999, included: 99999, excluded: 99999, renamed: 99999, warnings: 99999, errors: 0, zip64: false, sourceBytes: 0 },
      findings,
      entries: [excludedPlanned],
      instructions: { output: "/out.zip", writable: true, zip64: false, policy, overwrite: false, timeZone: "UTC", entries: [] },
    };

    // Build the real document with maximum-width write-time fields (crc32 at its
    // sentinel, a full 64-hex sha, compressedSize = size), then measure it.
    const inputs: ManifestEntryInput[] = writeEntries.map((e) => ({
      writeEntry: e,
      crc32: 0xffffffff,
      compressedSize: e.size,
      sha256: "f".repeat(64),
    }));
    const doc = buildManifest(planDoc, policy, inputs, { createdNs: 1_893_456_000_000_000_000n, timeZone: "Asia/Tokyo", comment: comment });
    const realBytes = Buffer.byteLength(JSON.stringify(doc, null, 2), "utf8");

    const content: ManifestContent = {
      entries: writeEntries,
      excluded: excludedRecords({ entries: [excludedPlanned] }),
      findings,
      comment,
    };

    expect(estimateManifestSize(content, policy)).toBeGreaterThanOrEqual(realBytes);
  });
});
