/**
 * The scan edge over a real temporary tree. Covers the I/O-heavy behaviors the
 * pure planner cannot exercise: forward-slash archive paths, excluded-directory
 * pruning during the walk, symlink handling across ignore/follow, the cycle
 * guard and input-tree escape rule, broken-link drop, a symlink given directly
 * as a top-level input, and the output-artifact self-exclusion.
 */

import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matcherFor } from "../../src/filter/match.ts";
import { createLogger } from "../../src/log/logger.ts";
import { resolvePolicy } from "../../src/policy.ts";
import { scan } from "../../src/scan/scan.ts";
import type { ArchivePolicy, ArchiveSpec } from "../../src/types.ts";
import { realVolume } from "../helpers/volume.ts";
import { ZipKit } from "../../src/index.ts";
import { nodeFileSystem, Volume } from "../../src/internal/volume.ts";
import { createDirectoryLink, createFileLink, fileSymlinksSupported } from "../helpers/symlink.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zipkit-scan-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(policy: ArchivePolicy) {
  return {
    matcher: matcherFor(policy),
    logger: createLogger(),
    signal: undefined,
    volume: realVolume(),
  };
}

async function runScan(spec: ArchiveSpec, partial: Partial<ArchivePolicy> = {}, volume?: Volume) {
  const policy = resolvePolicy(undefined, partial);
  return scan(spec, policy, { ...deps(policy), ...(volume ? { volume } : {}) });
}

function names(result: { entries: { archivePath: string }[] }): string[] {
  return result.entries.map((e) => e.archivePath).sort();
}

describe("scan over a real tree", () => {
  it("cancels a followed descendant once the file call in hand ends", async () => {
    const proj = path.join(dir, "proj"), target = path.join(dir, "target");
    await mkdir(proj); await mkdir(target);
    await writeFile(path.join(target, "a.txt"), "content");
    await writeFile(path.join(target, "b.txt"), "content");
    await createDirectoryLink(target, path.join(proj, "link"));
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const held = new Promise<void>((r) => { release = r; });
    const controller = new AbortController();
    const canonicalTarget = await nodeFileSystem.realpath(target);
    const looked: string[] = [];
    const volume = new Volume({ ...nodeFileSystem, lstat: async (name) => {
      if (path.dirname(name) !== canonicalTarget) return nodeFileSystem.lstat(name);
      looked.push(name);
      if (looked.length === 1) { entered(); await held; }
      return nodeFileSystem.lstat(name);
    } }, controller.signal);
    const policy = resolvePolicy(undefined, { symlinks: "follow", followExternal: true });
    const work = scan({ inputs: [proj] }, policy, {
      ...deps(policy), volume, signal: controller.signal,
    });
    await started; controller.abort(); release();
    await expect(work).rejects.toHaveProperty("code", "operation.cancelled");
    expect(looked).toHaveLength(1);
  });

  it("includes each named root when multiple input directories are empty", async () => {
    const roots = [path.join(dir, "first"), path.join(dir, "second")];
    await Promise.all(roots.map((root) => mkdir(root)));

    const result = await runScan({ inputs: roots });

    expect(result.entries.map((entry) => ({ archivePath: entry.archivePath, type: entry.type, diskPath: entry.diskPath }))).toEqual([
      { archivePath: "first", type: "dir", diskPath: roots[0] },
      { archivePath: "second", type: "dir", diskPath: roots[1] },
    ]);
  });

  it("prunes an excluded named root before listing its contents", async () => {
    const excluded = path.join(dir, "__MACOSX"), kept = path.join(dir, "kept");
    await mkdir(excluded); await mkdir(kept);
    await writeFile(path.join(excluded, "hidden.txt"), "hidden");
    const listed: string[] = [];
    const volume = new Volume({ ...nodeFileSystem, readdir: async (name) => {
      listed.push(name);
      return nodeFileSystem.readdir(name);
    } });

    const result = await runScan({ inputs: [excluded, kept] }, {}, volume);

    expect(names(result)).toEqual(["kept"]);
    expect(result.prunedDirs.map((entry) => entry.archivePath)).toEqual(["__MACOSX"]);
    expect(listed).toEqual([kept]);
  });

  it("fails on an unlistable root but records an unlistable descendant as unlisted", async () => {
    const proj = path.join(dir, "proj"), locked = path.join(proj, "locked");
    await mkdir(locked, { recursive: true });
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const inaccessible = (blocked: string) => new Volume({ ...nodeFileSystem,
      readdir: async (name) => {
        if (name === blocked) throw denied;
        return nodeFileSystem.readdir(name);
      },
    });
    await expect(runScan({ inputs: [proj] }, {}, inaccessible(proj))).rejects.toMatchObject({ code: "path.denied", subject: proj });
    const result = await runScan({ inputs: [proj] }, {}, inaccessible(locked));
    expect(names(result)).toEqual(["locked"]);
    expect(result.unlistedDirs).toEqual(["locked"]);
  });

  it("surfaces files and directories with forward-slash archive paths", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(path.join(proj, "sub"), { recursive: true });
    await writeFile(path.join(proj, "a.txt"), "a");
    await writeFile(path.join(proj, "sub", "b.txt"), "b");

    const result = await runScan({ inputs: [proj] });

    expect(names(result)).toEqual(["a.txt", "sub", "sub/b.txt"]);
    expect(result.entries.find((e) => e.archivePath === "sub")?.type).toBe("dir");
    expect(result.entries.find((e) => e.archivePath === "sub/b.txt")?.type).toBe("file");
  });

  it("prunes directories an exclusion pattern matches during the walk", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(path.join(proj, "__MACOSX"), { recursive: true });
    await writeFile(path.join(proj, "__MACOSX", "x.txt"), "junk");
    await writeFile(path.join(proj, "keep.txt"), "keep");

    const result = await runScan({ inputs: [proj] });

    expect(names(result)).toEqual(["keep.txt"]);
    expect(result.prunedDirs.map((d) => d.archivePath)).toContain("__MACOSX");
  });

  it.runIf(fileSymlinksSupported)("surfaces a symlink as a symlink entry under the default ignore policy", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "real.txt"), "real");
    await createFileLink("real.txt", path.join(proj, "link"));

    const result = await runScan({ inputs: [proj] });

    const link = result.entries.find((e) => e.archivePath === "link");
    expect(link?.type).toBe("symlink");
    expect(link?.linkTarget).toBeUndefined();
  });

  it.runIf(fileSymlinksSupported).each(["ignore", "follow", "preserve"] as const)("reads a symlink target only for preservation under %s", async (symlinks) => {
    const proj = path.join(dir, "proj");
    await mkdir(proj);
    await writeFile(path.join(proj, "real.txt"), "real");
    const linkPath = path.join(proj, "link");
    await createFileLink("real.txt", linkPath);
    const reads: string[] = [];
    const volume = new Volume({ ...nodeFileSystem, readlink: async (name) => {
      reads.push(name);
      return nodeFileSystem.readlink(name);
    } });

    const result = await runScan({ inputs: [proj] }, { symlinks }, volume);

    expect(reads).toEqual(symlinks === "preserve" ? [linkPath] : []);
    const entry = result.entries.find((item) => item.archivePath === "link");
    expect(entry?.type).toBe(symlinks === "follow" ? "file" : "symlink");
    expect(entry?.linkTarget).toBe(symlinks === "preserve" ? "real.txt" : undefined);
  });

  it("follows an internal symlinked directory under follow", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(path.join(proj, "data"), { recursive: true });
    await writeFile(path.join(proj, "data", "f.txt"), "f");
    await createDirectoryLink("data", path.join(proj, "mirror"));

    const result = await runScan({ inputs: [proj] }, { symlinks: "follow" });

    expect(names(result)).toContain("data/f.txt");
    expect(names(result)).toContain("mirror/f.txt");
    const mirrored = result.entries.find((e) => e.archivePath === "mirror/f.txt");
    expect(mirrored?.type).toBe("file");
  });

  it("guards against symlink cycles under follow", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(path.join(proj, "child"), { recursive: true });
    await writeFile(path.join(proj, "child", "f.txt"), "f");
    // A symlink pointing back at its own parent directory.
    await createDirectoryLink("../child", path.join(proj, "child", "self"));

    // The guard's contract is that this terminates rather than recursing
    // forever; a hang would fail the test by timeout.
    const result = await runScan({ inputs: [proj] }, { symlinks: "follow" });

    expect(names(result)).toContain("child/f.txt");
    expect(names(result)).toContain("child/self/f.txt");
    // Followed once, then the cycle guard stops descent — not twice.
    expect(names(result)).not.toContain("child/self/self/f.txt");
  });

  it("skips a symlink that escapes the input tree unless followExternal is set", async () => {
    const proj = path.join(dir, "proj");
    const outside = path.join(dir, "outside");
    await mkdir(proj, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await createDirectoryLink("../outside", path.join(proj, "escape"));

    const blocked = await runScan({ inputs: [proj] }, { symlinks: "follow" });
    expect(names(blocked)).not.toContain("escape/secret.txt");
    expect(blocked.skipped).toEqual([{ archivePath: "escape", sourcePath: "proj/escape", diskPath: path.join(proj, "escape"), kind: "external-link" }]);

    const allowed = await runScan(
      { inputs: [proj] },
      { symlinks: "follow", followExternal: true },
    );
    expect(names(allowed)).toContain("escape/secret.txt");
  });

  it("follows a link to a folder inside the input whose name starts with two dots", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(path.join(proj, "..notes"), { recursive: true });
    await writeFile(path.join(proj, "..notes", "n.txt"), "note");
    await createDirectoryLink("..notes", path.join(proj, "notes-link"));

    const result = await runScan({ inputs: [proj] }, { symlinks: "follow" });
    expect(names(result)).toContain("notes-link/n.txt");
    expect(result.skipped).toEqual([]);
  });

  it.runIf(fileSymlinksSupported)("drops a broken symlink under follow", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "real.txt"), "real");
    await createFileLink("does-not-exist", path.join(proj, "dangling"));

    const result = await runScan({ inputs: [proj] }, { symlinks: "follow" });

    expect(names(result)).toEqual(["real.txt"]);
    expect(result.skipped).toEqual([{ archivePath: "dangling", sourcePath: "proj/dangling", diskPath: path.join(proj, "dangling"), kind: "broken-link" }]);
  });

  // A FIFO is a POSIX object; Windows has no mkfifo.
  it.skipIf(process.platform === "win32")("records a FIFO as skipped rather than dropping it silently", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "real.txt"), "real");
    execFileSync("mkfifo", [path.join(proj, "pipe")]);

    const result = await runScan({ inputs: [proj] });

    expect(names(result)).toEqual(["real.txt"]);
    expect(result.skipped).toEqual([{ archivePath: "pipe", sourcePath: "proj/pipe", diskPath: path.join(proj, "pipe"), kind: "fifo" }]);
  });

  it.skipIf(process.platform === "win32")("classifies a directly named FIFO as unsupported", async () => {
    const pipe = path.join(dir, "pipe");
    execFileSync("mkfifo", [pipe]);

    const result = await runScan({ inputs: [pipe] });

    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([{ archivePath: "pipe", sourcePath: "pipe", diskPath: pipe, kind: "fifo" }]);
  });

  // POSIX permissions decide whether a folder can be listed; root lists anything.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "records a subfolder it cannot list",
    async () => {
      const proj = path.join(dir, "proj");
      const locked = path.join(proj, "locked");
      await mkdir(locked, { recursive: true });
      await writeFile(path.join(locked, "hidden.txt"), "hidden");
      await writeFile(path.join(proj, "a.txt"), "a");
      await chmod(locked, 0o000);
      try {
        const result = await runScan({ inputs: [proj] });
        expect(names(result)).toEqual(["a.txt", "locked"]);
        expect(result.unlistedDirs).toEqual(["locked"]);
      } finally {
        await chmod(locked, 0o755);
      }
    },
  );

  it("follows a symlink given directly as a top-level input", async () => {
    const realdir = path.join(dir, "realdir");
    await mkdir(realdir, { recursive: true });
    await writeFile(path.join(realdir, "f.txt"), "f");
    const linkdir = path.join(dir, "linkdir");
    await createDirectoryLink("realdir", linkdir);

    // Default policy is "ignore", but an explicit symlink input is always
    // followed because it was named by the caller.
    const result = await runScan({ inputs: [linkdir] });

    expect(names(result)).toContain("f.txt");
  });

  it("never archives the output file itself, but keeps every real neighbour", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "a.txt"), "a");
    const output = path.join(proj, "out.zip");
    await writeFile(output, "existing archive");
    // Siblings that share the output's prefix are real files, never guessed to be
    // atomic-write temps — including a numeric suffix that resembles one. Only the
    // output file itself (matched by identity) is excluded.
    await writeFile(path.join(proj, "out.zip.20240604"), "a dated backup");
    await writeFile(path.join(proj, "out.zip.notes"), "release notes");

    const result = await runScan({ inputs: [proj], output });

    expect(names(result)).toEqual(["a.txt", "out.zip.20240604", "out.zip.notes"]);
    expect(result.outputExists).toBe(true);
  });

  it.runIf(fileSymlinksSupported)("excludes an existing output reached through a followed symlink alias", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(proj, { recursive: true });
    const output = path.join(dir, "out.zip");
    await writeFile(output, "existing archive");
    await createFileLink(output, path.join(proj, "archive-alias"));
    await writeFile(path.join(proj, "keep.txt"), "keep");

    const result = await runScan({ inputs: [proj], output }, { symlinks: "follow", followExternal: true });

    expect(names(result)).toEqual(["keep.txt"]);
  });
});

describe("folders whose names start with a dot", () => {
  it("are walked like any other: nothing is skipped by its name (the exclusion patterns are applied when planning)", async () => {
    const home = path.join(dir, "home");
    await mkdir(path.join(home, ".zipkit", "logs"), { recursive: true });
    await mkdir(path.join(home, ".config"));
    await writeFile(path.join(home, ".zipkit", "logs", "session.log"), "live");
    await writeFile(path.join(home, ".config", "app.toml"), "x = 1");
    await writeFile(path.join(home, ".DS_Store"), "finder");
    expect(names(await runScan({ inputs: [home] }))).toEqual([".DS_Store", ".config", ".config/app.toml", ".zipkit", ".zipkit/logs", ".zipkit/logs/session.log"]);
  });
});

describe("a backslash in a name", () => {
  // Only Windows separates folders with a backslash; elsewhere a file may be
  // named with one, and it stays one file whose name the name rules fix.
  it.runIf(process.platform !== "win32")("stays part of the name on a file system that allows it", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "a\\b.txt"), "one file");
    const result = await runScan({ inputs: [proj] });
    expect(names(result)).toEqual(["a\\b.txt"]);
    const plan = await new ZipKit().plan({ inputs: [proj], output: path.join(dir, "out.zip") });
    expect(plan.entries.map((e) => e.archivePath)).toEqual(["a_b.txt"]);
    expect(plan.findings.map((f) => f.rule)).toContain("name.invalid-char");
  });
});
