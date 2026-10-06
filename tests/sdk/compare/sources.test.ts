/**
 * The delete gate's source check, end to end through `compareSources`: an
 * archive's inputs re-scanned against its embedded manifest. Only included
 * files and symlinks count, by source path, type, size and modification time;
 * junk written into the tree and folder times do not.
 */

import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipKit } from "../../../src/sdk/index.js";
import { compareWithManifest } from "../../../src/sdk/compare/sources.js";
import { scanEntry } from "../../helpers/synthetic.js";

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
  await new ZipKit({ sessionLog: false }).create({ inputs: [proj], output });
});

afterEach(async () => {
  await chmod(path.join(proj, "sub"), 0o755).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

const compare = () => new ZipKit({ sessionLog: false }).compareSources({ inputs: [proj], output }, output);

describe("compareSources", () => {
  it("matches an untouched tree, even after junk lands and folder times move", async () => {
    await writeFile(path.join(proj, ".DS_Store"), "finder");
    await utimes(path.join(proj, "sub"), new Date(2001, 0, 1), new Date(2001, 0, 1));
    expect(await compare()).toEqual({ matches: true, added: [], missing: [], changed: [], unlisted: [] });
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

  it("fails when the archive holds no manifest", async () => {
    const bare = path.join(dir, "bare.zip");
    await new ZipKit({ sessionLog: false }).create({ inputs: [proj], output: bare, policy: { metadata: false } });
    await expect(new ZipKit({ sessionLog: false }).compareSources({ inputs: [proj] }, bare)).rejects.toMatchObject({
      code: "read.manifest-missing",
    });
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
