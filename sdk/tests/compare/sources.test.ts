/**
 * The delete gate's source check, end to end through `checkRemoval`: an
 * archive's inputs re-scanned against its embedded manifest. Only included
 * files and symlinks count, by source path, type, size, modification time and
 * content; junk written into the tree and folder times do not.
 */

import { chmod, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipKit, type SourceComparison } from "../../src/index.ts";
import { compareWithManifest } from "../../src/compare/sources.ts";
import { scanEntry } from "../helpers/synthetic.ts";

let dir: string;
let proj: string;
let output: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zipkit-compare-"));
  proj = path.join(dir, "proj");
  await mkdir(path.join(proj, "sub"), { recursive: true });
  await writeFile(path.join(proj, "a.txt"), "alpha");
  await writeFile(path.join(proj, "sub", "b.txt"), "beta");
  output = path.join(dir, "proj.zip");
  await new ZipKit().create({ inputs: [proj], output });
});

afterEach(async () => {
  await chmod(path.join(proj, "sub"), 0o755).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

const SAME = { matches: true, added: [], missing: [], changed: [], unlisted: [] };

/** The removal check's comparison: the same as archived, or what its refusal says changed. */
async function compare(archive = output, spec = { inputs: [proj] }): Promise<SourceComparison> {
  const { refusal } = await new ZipKit().checkRemoval(spec, archive);
  if (refusal === null) return SAME;
  if (refusal.reason !== "changed") throw new Error(`refused for ${refusal.reason}`);
  return refusal.comparison;
}

/** Rewrite a file with same-size content and put its modification time back. */
async function editKeepingTime(file: string, content: string): Promise<void> {
  const before = await stat(file);
  await writeFile(file, content);
  await utimes(file, before.atime, before.mtime);
}

describe("the source check", () => {
  it("matches an untouched tree, even after junk lands and folder times move", async () => {
    await writeFile(path.join(proj, ".DS_Store"), "finder");
    await utimes(path.join(proj, "sub"), new Date(2001, 0, 1), new Date(2001, 0, 1));
    expect(await compare()).toEqual(SAME);
  });

  it("reports a file added, one removed and one edited since archiving", async () => {
    await writeFile(path.join(proj, "new.txt"), "new");
    await rm(path.join(proj, "a.txt"));
    await writeFile(path.join(proj, "sub", "b.txt"), "BETA!");
    expect(await compare()).toEqual({
      matches: false,
      added: ["proj/new.txt"],
      missing: ["proj/a.txt"],
      changed: ["proj/sub/b.txt"],
      unlisted: [],
    });
  });

  it("reports a same-size edit whose modification time was kept, by its SHA-256", async () => {
    await editKeepingTime(path.join(proj, "sub", "b.txt"), "BETA");
    expect(await compare()).toEqual({ ...SAME, matches: false, changed: ["proj/sub/b.txt"] });
  });

  it("compares by CRC-32 when the archive recorded no SHA-256", async () => {
    const crcOnly = path.join(dir, "crc.zip");
    const policy = { manifest: { hash: false } };
    await new ZipKit().create({ inputs: [proj], output: crcOnly, policy });
    expect(await compare(crcOnly, { inputs: [proj], policy } as never)).toEqual(SAME);
    await editKeepingTime(path.join(proj, "a.txt"), "ALPHA");
    expect((await compare(crcOnly, { inputs: [proj], policy } as never)).changed).toEqual(["proj/a.txt"]);
  });

  it("reports a file whose modification time alone changed", async () => {
    await utimes(path.join(proj, "a.txt"), new Date(2001, 0, 1), new Date(2001, 0, 1));
    expect((await compare()).changed).toEqual(["proj/a.txt"]);
  });

  // POSIX permissions decide whether a folder can be listed; root lists anything.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "does not match when a folder can no longer be listed",
    async () => {
      await chmod(path.join(proj, "sub"), 0o000);
      const result = await compare();
      expect(result.matches).toBe(false);
      expect(result.unlisted).toEqual(["proj/sub"]);
    },
  );

  it("refuses when the archive holds no manifest", async () => {
    const bare = path.join(dir, "bare.zip");
    await new ZipKit().create({ inputs: [proj], output: bare, policy: { manifest: false } });
    const { refusal } = await new ZipKit().checkRemoval({ inputs: [proj] }, bare);
    expect(refusal).toMatchObject({ reason: "error", step: "verify", error: { code: "manifest.missing" } });
  });
});

describe("compareWithManifest", () => {
  const fresh = (sourcePath: string, size = 5) => {
    const e = scanEntry({ archivePath: sourcePath, sourcePath, size });
    return { ...e, method: "store" as const, originalPath: e.archivePath, transformations: [] };
  };
  const record = (sourcePath: string, size = 5, type: "file" | "dir" = "file") => ({
    archivePath: sourcePath,
    sourcePath,
    type,
    size,
    crc32: 0,
    mtime: { ns: fresh(sourcePath).mtimeNs.toString() },
  });

  it("tells two inputs sharing a basename apart by count", () => {
    expect(compareWithManifest([fresh("d/x"), fresh("d/x")], [], [record("d/x"), record("d/x")]).matches).toBe(true);
    expect(compareWithManifest([fresh("d/x"), fresh("d/x", 6)], [], [record("d/x"), record("d/x")]).changed).toEqual(["d/x"]);
  });

  it("ignores folder records", () => {
    expect(compareWithManifest([], [], [record("d", 0, "dir")]).matches).toBe(true);
  });
});
