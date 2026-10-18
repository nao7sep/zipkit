/**
 * What is at a path, as the engine must tell it apart: there, gone, or out of
 * reach. A path on a drive that is not connected, or one that cannot be read,
 * is out of reach and never taken for a deletion.
 */

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyPaths, mountPointOf, pathState, sameFile } from "../src/paths.js";
import { ZipKit } from "../src/index.js";
import { nodeFileSystem, Volume } from "../src/internal/volume.js";

const volume = new Volume(nodeFileSystem, 30_000);
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "zipkit-path-state-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("mountPointOf", () => {
  it("names the mount point of a removable or network drive, and nothing for the system drive", () => {
    expect(mountPointOf("/Volumes/Backup/photos/a.jpg", "darwin")).toBe("/Volumes/Backup");
    expect(mountPointOf("/Users/me/photos", "darwin")).toBeNull();
    expect(mountPointOf("/media/me/USB/a.txt", "linux")).toBe("/media/me/USB");
    expect(mountPointOf("/run/media/me/USB/a.txt", "linux")).toBe("/run/media/me/USB");
    expect(mountPointOf("/mnt/share/a.txt", "linux")).toBe("/mnt/share");
    expect(mountPointOf("/home/me/a.txt", "linux")).toBeNull();
    expect(mountPointOf("E:\\photos\\a.jpg", "win32")).toBe("E:\\");
    expect(mountPointOf("\\\\server\\share\\a.txt", "win32")).toBe("\\\\server\\share\\");
  });
});

describe("pathState", () => {
  it("tells a file there, the same file rewritten, and a file gone", async () => {
    const file = path.join(root, "a.zip");
    await writeFile(file, "first");
    const first = await pathState(file, volume);
    expect(first).toEqual({ kind: "present", fingerprint: expect.any(String) });
    await writeFile(file, "a longer second version");
    const rewritten = await pathState(file, volume);
    // Rewritten in place: the same file with other content.
    expect(sameFile((first as { fingerprint: string }).fingerprint, (rewritten as { fingerprint: string }).fingerprint)).toBe(true);
    const other = path.join(root, "other.zip");
    await writeFile(other, "first");
    const another = await pathState(other, volume);
    expect(sameFile((first as { fingerprint: string }).fingerprint, (another as { fingerprint: string }).fingerprint)).toBe(false);
    await rm(file);
    expect(await pathState(file, volume)).toEqual({ kind: "gone" });
  });

  it("reads a path on a drive that is not connected as out of reach, not gone", async () => {
    expect(await pathState("/Volumes/ZipKitNoSuchDrive/archive.zip", volume, "darwin")).toEqual({ kind: "unavailable" });
    expect(await pathState("/mnt/zipkit-no-such-share/archive.zip", volume, "linux")).toEqual({ kind: "unavailable" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reads a path that cannot be read as out of reach, not gone", async () => {
    const locked = path.join(root, "locked");
    await mkdir(locked);
    await writeFile(path.join(locked, "a.zip"), "x");
    await chmod(locked, 0o000);
    try {
      expect(await pathState(path.join(locked, "a.zip"), volume)).toEqual({ kind: "unavailable" });
    } finally { await chmod(locked, 0o755); }
  });
});

describe("classifyPaths", () => {
  it("classifies each path in order: a folder, a file, a link whose target is gone, a missing path, and one on a drive that is not connected", async () => {
    const file = path.join(root, "a.txt");
    await writeFile(file, "x");
    const folder = path.join(root, "folder");
    await mkdir(folder);
    const link = path.join(root, "dangling");
    await symlink(path.join(root, "nowhere"), link);
    const entries = await classifyPaths([folder, file, link, path.join(root, "gone.txt"), "/Volumes/ZipKitNoSuchDrive/a.txt"], volume, "darwin");
    expect(entries.map((entry) => entry.kind)).toEqual(["directory", "file", "other", "missing", "unavailable"]);
    expect(await classifyPaths([], volume)).toEqual([]);
  });

  it("is what ZipKit.classify and ZipKit.pathState answer", async () => {
    const file = path.join(root, "a.txt");
    await writeFile(file, "x");
    const zip = new ZipKit();
    expect(await zip.classify([file])).toEqual([{ path: file, kind: "file" }]);
    expect((await zip.pathState(file)).kind).toBe("present");
    expect(await zip.pathState(path.join(root, "gone"))).toEqual({ kind: "gone" });
  });
});
