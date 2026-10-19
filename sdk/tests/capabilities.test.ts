/**
 * What an app reads from the SDK beyond a verdict: where each planned item is
 * on disk, how much the archive holds as on disk, how far a write or a read
 * has got, and what an
 * archive holds without verifying it.
 */

import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipKit, ZipKitError } from "../src/index.ts";
import type { ProgressCounts } from "../src/index.ts";
import { Meter } from "../src/progress.ts";
import { createDirectoryLink } from "./helpers/symlink.ts";

let root: string;
let proj: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zipkit-capabilities-"));
  proj = path.join(root, "proj");
  await mkdir(path.join(proj, "sub"), { recursive: true });
  await writeFile(path.join(proj, "a.txt"), "alpha");
  await writeFile(path.join(proj, "sub", "b.txt"), "bravo!");
  await writeFile(path.join(proj, ".DS_Store"), "junk");
});
afterEach(() => rm(root, { recursive: true, force: true }));

const byPath = <T extends { archivePath: string }>(entries: T[]) => new Map(entries.map((e) => [e.archivePath, e]));

describe("planned entries", () => {
  it("say where each item is on disk, from the input as given and through a followed link", async () => {
    const other = path.join(root, "other");
    await mkdir(other);
    await writeFile(path.join(other, "c.txt"), "charlie");
    await createDirectoryLink(other, path.join(proj, "linked"));
    const plan = await new ZipKit().plan({ inputs: [proj], output: path.join(root, "o.zip"), policy: { symlinks: "follow", followExternal: true } });
    const entries = byPath(plan.entries);
    expect(entries.get("sub/b.txt")?.diskPath).toBe(path.join(proj, "sub", "b.txt"));
    expect(entries.get(".DS_Store")?.diskPath).toBe(path.join(proj, ".DS_Store"));
    // The place the user sees, not the link's target.
    expect(entries.get("linked/c.txt")?.diskPath).toBe(path.join(proj, "linked", "c.txt"));
    const file = await new ZipKit().plan({ inputs: [path.join(proj, "a.txt")], output: path.join(root, "f.zip") });
    expect(file.entries[0]?.diskPath).toBe(path.join(proj, "a.txt"));
  });

  it("count the bytes of what is archived as on disk, which the write streams in full", async () => {
    const zip = new ZipKit();
    const plan = await zip.plan({ inputs: [proj], output: path.join(root, "o.zip") });
    expect(plan.summary.sourceBytes).toBe("alpha".length + "bravo!".length);
    const counts: ProgressCounts[] = [];
    const written = await zip.write(plan, { onProgress: (c) => counts.push(c) });
    expect(counts[0]).toEqual({ stage: "write", entriesDone: 0, entriesTotal: 3, bytesDone: 0, bytesTotal: 11 });
    expect(counts.at(-1)).toEqual({ stage: "write", entriesDone: 3, entriesTotal: 3, bytesDone: 11, bytesTotal: 11 });
    expect(written.manifest?.summary.sourceBytes).toBe(11);
  });
});

describe("onProgress", () => {
  it("follows a read to its last entry and byte, the manifest included", async () => {
    const zip = new ZipKit();
    const archive = path.join(root, "o.zip");
    await zip.create({ inputs: [proj], output: archive });
    const listing = await zip.list(archive);
    const counts: ProgressCounts[] = [];
    await zip.verify(archive, { manifest: true, onProgress: (c) => counts.push(c) });
    const bytes = listing.entries.reduce((sum, e) => sum + e.size, 0);
    expect(counts[0]).toMatchObject({ stage: "verify", entriesDone: 0, bytesDone: 0 });
    expect(counts.at(-1)).toEqual({ stage: "verify", entriesDone: listing.entries.length, entriesTotal: listing.entries.length, bytesDone: bytes, bytesTotal: bytes });
  });

  it("reports at most every 100 ms between the first and the last, and survives an observer that throws", () => {
    let now = 0;
    const seen: number[] = [];
    const meter = new Meter("write", { entries: 3, bytes: 30 }, (c) => { seen.push(c.bytesDone); throw new Error("observer"); }, () => now);
    meter.bytes(10); // too soon after the start
    now = 50; meter.bytes(10);
    now = 120; meter.entry();
    now = 130; meter.bytes(10);
    meter.finish();
    expect(seen).toEqual([0, 20, 30]);
    // With no observer it does nothing at all.
    expect(() => new Meter("verify", { entries: 1, bytes: 1 }, undefined).finish()).not.toThrow();
  });
});

describe("list and readManifest", () => {
  it("list the entries without verifying them, and read the manifest whole", async () => {
    const zip = new ZipKit();
    const archive = path.join(root, "o.zip");
    const when = new Date("2026-05-04T03:02:01Z");
    await utimes(path.join(proj, "a.txt"), when, when);
    await zip.create({ inputs: [proj], output: archive });
    const listing = await zip.list(archive);
    expect(listing.archive).toBe(archive);
    const entries = byPath(listing.entries);
    expect(entries.get("a.txt")).toMatchObject({ type: "file", method: "deflate", size: 5, crc32: expect.any(Number) });
    expect(entries.get("a.txt")?.modified.iso).toBe("2026-05-04T03:02:01.000Z");
    expect(entries.has("zipkit.json")).toBe(true);
    const manifest = await zip.readManifest(archive);
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.entries.map((e) => e.archivePath).sort()).toEqual(["a.txt", "sub", "sub/b.txt"]);
    expect(manifest.summary.sourceBytes).toBe(11);
  });

  it("refuse an archive without a manifest, and a file that is not a ZIP", async () => {
    const zip = new ZipKit();
    const bare = path.join(root, "bare.zip");
    await zip.create({ inputs: [proj], output: bare, policy: { manifest: false } });
    expect((await zip.list(bare)).entries.length).toBeGreaterThan(0);
    await expect(zip.readManifest(bare)).rejects.toMatchObject({ code: "manifest.missing" });
    const text = path.join(root, "not.zip");
    await writeFile(text, "x".repeat(100));
    await expect(zip.list(text)).rejects.toBeInstanceOf(ZipKitError);
    expect((await stat(text)).size).toBe(100);
  });
});
