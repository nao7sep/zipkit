import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ZipKit } from "../src/zipkit.ts";
import { ZipKitError } from "../src/errors.ts";
import { nodeFileSystem, Volume, type FileSystemPort } from "../src/internal/volume.ts";
import { createDirectoryLink, createFileLink, fileSymlinksSupported } from "./helpers/symlink.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "zipkit-lifecycle-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function withPort(port: FileSystemPort) {
  return new class extends ZipKit {
    override volume(signal?: AbortSignal) { return new Volume(port, signal); }
  }();
}

it.skipIf(!fileSymlinksSupported).each([["EACCES", "path.denied"], ["ENOENT", "path.missing"]])("refuses unreadable preserved links instead of inventing their target (%s)", async (errno, code) => {
  const input = path.join(root, "input"), link = path.join(input, "link");
  await mkdir(input); await createFileLink("target", link);
  const denied = Object.assign(new Error(errno), { code: errno });
  const zip = withPort({ ...nodeFileSystem, readlink: async (file) => {
    if (file === link) throw denied;
    return nodeFileSystem.readlink(file);
  } });
  const output = path.join(root, "out.zip");
  await expect(zip.create({ inputs: [input], output, policy: { symlinks: "preserve" } })).rejects.toMatchObject({ code, subject: link });
  expect(existsSync(output)).toBe(false);
  expect((await zip.plan({ inputs: [input], output, policy: { symlinks: "ignore" } })).writable).toBe(true);
});

it.skipIf(!fileSymlinksSupported)("rechecks a preserved descendant target before publishing a stale plan", async () => {
  const input = path.join(root, "input"), link = path.join(input, "link"), output = path.join(root, "out.zip");
  await mkdir(input); await createFileLink("target-a", link);
  const zip = new ZipKit();
  const plan = await zip.plan({ inputs: [input], output, policy: { symlinks: "preserve" } });
  await rm(link); await createFileLink("target-b", link);
  // Same-size replacement may retain the recorded timestamp. Comparing the
  // actual target must still refuse it.
  const scanned = await nodeFileSystem.lstat(link);
  scanned.mtimeNs = BigInt(plan.instructions.entries[0]!.mtimeNs);
  const writer = withPort({ ...nodeFileSystem, lstat: async (file) => file === link ? scanned : nodeFileSystem.lstat(file) });
  await expect(writer.write(plan)).rejects.toMatchObject({ code: "write.source-changed", subject: link });
  expect(readdirSync(root)).toEqual(["input"]);
});

it.skipIf(!fileSymlinksSupported).each(["missing", "file"])("refuses a preserved link that became %s", async (change) => {
  const input = path.join(root, "input"), link = path.join(input, "link"), output = path.join(root, "out.zip");
  await mkdir(input); await createFileLink("target", link);
  const zip = new ZipKit();
  const plan = await zip.plan({ inputs: [input], output, policy: { symlinks: "preserve" } });
  await rm(link);
  if (change === "file") await writeFile(link, "target");
  await expect(zip.write(plan)).rejects.toMatchObject({ code: change === "missing" ? "path.missing" : "write.source-changed", subject: link });
  expect(readdirSync(root)).toEqual(["input"]);
});

it("can follow a resolvable link when its text is unreadable", async () => {
  const input = path.join(root, "input"), target = path.join(root, "target"), link = path.join(input, "link");
  await mkdir(input); await mkdir(target); await writeFile(path.join(target, "file.txt"), "x");
  await createDirectoryLink(target, link);
  const zip = withPort({ ...nodeFileSystem, readlink: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
  const plan = await zip.plan({ inputs: [input], output: path.join(root, "out.zip"), policy: { symlinks: "follow", followExternal: true } });
  expect(plan.entries.map((entry) => entry.archivePath)).toContain("link/file.txt");
});

it.skipIf(!fileSymlinksSupported)("writes an unchanged preserved link and verifies its recorded target", async () => {
  const input = path.join(root, "input"), output = path.join(root, "out.zip");
  await mkdir(input); await createFileLink("target", path.join(input, "link"));
  const zip = new ZipKit();
  const written = await zip.create({ inputs: [input], output, policy: { symlinks: "preserve" } });
  expect(written.mode).toBe("write");
  expect((await zip.verify({ archive: output, manifest: true })).ok).toBe(true);
});

it.skipIf(!fileSymlinksSupported)("preserves an unreadable target failure during the write recheck", async () => {
  const input = path.join(root, "input"), link = path.join(input, "link"), output = path.join(root, "out.zip");
  await mkdir(input); await createFileLink("target", link);
  const plan = await new ZipKit().plan({ inputs: [input], output, policy: { symlinks: "preserve" } });
  const writer = withPort({ ...nodeFileSystem, readlink: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
  await expect(writer.write(plan)).rejects.toMatchObject({ code: "path.denied", subject: link });
  expect(readdirSync(root)).toEqual(["input"]);
});

it("does not list sibling directories after a directory listing fails", async () => {
  const input = path.join(root, "input"), a = path.join(input, "a"), b = path.join(input, "b");
  await mkdir(a, { recursive: true }); await mkdir(b);
  const original = new ZipKitError("io.failed", "listing failed", { subject: a });
  const opened: string[] = [];
  const zip = withPort({ ...nodeFileSystem, readdir: async (file) => {
    opened.push(file);
    if (file !== input) throw original;
    return nodeFileSystem.readdir(file);
  } });
  await expect(zip.plan({ inputs: [input], output: path.join(root, "out.zip") })).rejects.toBe(original);
  expect(opened).toHaveLength(2);
});
