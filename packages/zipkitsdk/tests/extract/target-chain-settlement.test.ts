import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { ZipKit } from "../../src/index.js";
import { buildZipFile } from "../helpers/writeZip.js";
import { fileSymlinksSupported } from "../helpers/symlink.js";

const times = {
  mtimeNs: 1_577_836_800_000_000_000n,
  atimeNs: 1_577_836_800_000_000_000n,
  birthtimeNs: 1_577_836_800_000_000_000n,
};

it.runIf(fileSymlinksSupported).each([
  { aliasTarget: "missing/../outside", safe: false, absolute: false },
  { aliasTarget: "missing/../inside", safe: true, absolute: false },
  { aliasTarget: "missing/still-dangling.txt", safe: true, absolute: false },
  { aliasTarget: "missing/nested/../../outside", safe: false, absolute: false },
  { aliasTarget: "missing/nested/../../inside", safe: true, absolute: false },
  { aliasTarget: "missing/../outside", safe: false, absolute: true },
  { aliasTarget: "missing/../inside", safe: true, absolute: true },
])("checks an alias before a later extracted directory activates it: $absolute/$aliasTarget", async ({ aliasTarget, safe, absolute }) => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-target-chain-settlement-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const dest = path.join(root, "dest"), outside = path.join(root, "outside");
  await mkdir(dest);
  await mkdir(outside);
  await mkdir(path.join(dest, "inside"));
  await symlink(outside, path.join(dest, "outside"));
  await symlink(absolute ? `${dest}/${aliasTarget}` : aliasTarget, path.join(dest, "alias"));
  const data = Buffer.from("alias");
  const createdDirectory = aliasTarget.startsWith("missing/nested/") ? "missing/nested" : "missing";
  const archive = await buildZipFile([
    { name: "newlink", type: "symlink", method: "store", raw: data,
      uncompressedSize: data.length, mode: 0o120777, ...times },
    { name: createdDirectory, type: "dir", method: "store", raw: Buffer.alloc(0),
      uncompressedSize: 0, mode: 0o40755, ...times },
  ], { timeZone: "UTC", chunkSize: 65536 });
  // The public SDK processes newlink first. Its own later directory entry,
  // rather than an external replacement, makes the existing alias resolvable.
  const result = await new ZipKit({ concurrency: 1 }).extract({ archive: archive.path, dest });
  expect(result.entries.find((entry) => entry.archivePath === createdDirectory)?.written).toBe(true);
  expect(result.reportOk).toBe(safe);
  const restored = path.join(dest, "newlink");
  if (!safe) {
    expect(result.entries.find((entry) => entry.archivePath === "newlink")).toMatchObject({ written: false, skipped: "unsafe" });
    await expect(lstat(restored)).rejects.toHaveProperty("code", "ENOENT");
    expect(await realpath(path.join(dest, "alias"))).toBe(await realpath(outside));
  } else {
    expect(result.entries.find((entry) => entry.archivePath === "newlink")?.written).toBe(true);
    expect((await lstat(restored)).isSymbolicLink()).toBe(true);
    if (aliasTarget.endsWith("/inside")) expect(await realpath(restored)).toBe(await realpath(path.join(dest, "inside")));
    else await expect(realpath(restored)).rejects.toHaveProperty("code", "ENOENT");
  }
});

it.runIf(fileSymlinksSupported).each([
  { replacement: ".", safe: false },
  { replacement: "other", safe: true },
])("keeps restored aliases contained when a later archive link replaces their target prefix: $replacement", async ({ replacement, safe }) => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-target-chain-rewrite-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const dest = path.join(root, "dest");
  await mkdir(dest);
  await mkdir(path.join(root, "escape"));
  for (const name of ["inner", "other", "escape"]) await mkdir(path.join(dest, name));
  await symlink("inner", path.join(dest, "deep"));
  await symlink("deep/../escape", path.join(dest, "alias"));
  const entries = [["newlink", "alias"], ["deep", replacement]].map(([name, target]) => {
    const raw = Buffer.from(target!);
    return { name: name!, type: "symlink" as const, method: "store" as const, raw,
      uncompressedSize: raw.length, mode: 0o120777, ...times };
  });
  const archive = await buildZipFile(entries, { timeZone: "UTC", chunkSize: 65536 });
  const result = await new ZipKit({ concurrency: 1 }).extract({ archive: archive.path, dest, overwrite: true });
  const restored = path.join(dest, "newlink");
  if (safe) {
    expect(result.reportOk).toBe(true);
    expect(result.entries.every((entry) => entry.written)).toBe(true);
    expect(await realpath(restored)).toBe(await realpath(path.join(dest, "escape")));
  } else {
    expect(result.reportOk).toBe(false);
    // Either dependent restoration may be refused, but a newly restored link
    // must not escape after another entry's entirely app-owned replacement.
    const resolved = await realpath(restored).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    expect(resolved).not.toBe(await realpath(path.join(root, "escape")));
  }
});

it.runIf(fileSymlinksSupported).each([
  { reverse: true, concurrency: 1, absolute: false, unchanged: false },
  { reverse: false, concurrency: 4, absolute: false, unchanged: false },
  { reverse: false, concurrency: 4, absolute: true, unchanged: false },
  { reverse: false, concurrency: 4, absolute: false, unchanged: true },
])("preserves restored target containment across ordering and accepted unchanged links: %j", async ({ reverse, concurrency, absolute, unchanged }) => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-link-ordered-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const dest = path.join(root, "dest"), outside = path.join(root, "escape");
  await mkdir(dest); await mkdir(outside);
  await mkdir(path.join(dest, "inner")); await mkdir(path.join(dest, "escape"));
  await symlink("inner", path.join(dest, "deep"));
  await symlink(absolute ? `${dest}/deep/../escape` : "deep/../escape", path.join(dest, "alias"));
  // Windows may normalize an absolute destination before creating the link.
  // Only a stored climb still depends on the intermediate link replacement.
  const dependsOnDeep = (await readlink(path.join(dest, "alias"))).split(/[\\/]/).includes("..");
  if (unchanged) await symlink("alias", path.join(dest, "newlink"));
  const sources = [["newlink", "alias"], ["deep", "."]];
  if (reverse) sources.reverse();
  const archive = await buildZipFile(sources.map(([name, target]) => {
    const raw = Buffer.from(target!);
    return { name: name!, type: "symlink" as const, method: "store" as const, raw,
      uncompressedSize: raw.length, mode: 0o120777, ...times };
  }), { timeZone: "UTC", chunkSize: 65536 });
  const result = await new ZipKit({ concurrency }).extract({ archive: archive.path, dest, overwrite: true });
  expect(result.reportOk).toBe(!dependsOnDeep);
  if (unchanged) expect(result.entries.find((entry) => entry.archivePath === "newlink")?.skipped).toBe("unchanged");
  const actual = await realpath(path.join(dest, "newlink")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  expect(actual).not.toBe(await realpath(outside));
});

it.runIf(fileSymlinksSupported).each([
  ["DEEP", "deep"], ["σParent", "ςParent"],
])("settles an implicit %s/%s link parent before accepting earlier targets", async (name, alias) => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-link-parent-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const dest = path.join(root, "dest"), outside = path.join(root, "escape");
  await mkdir(dest); await mkdir(outside);
  await symlink(`${alias}/ς/../escape`, path.join(dest, "alias"));
  const archive = await buildZipFile([["newlink", "alias"], [`${name}/σ`, ".."]].map(([entry, target]) => {
    const raw = Buffer.from(target!);
    return { name: entry!, type: "symlink" as const, method: "store" as const, raw,
      uncompressedSize: raw.length, mode: 0o120777, ...times };
  }), { timeZone: "UTC", chunkSize: 65536 });
  const result = await new ZipKit({ concurrency: 4 }).extract({ archive: archive.path, dest, overwrite: true });
  const parentAliases = await lstat(path.join(dest, alias)).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  expect(result.reportOk).toBe(!parentAliases);
  expect(result.entries.find((entry) => entry.archivePath === "newlink")?.written).toBe(true);
  const actual = await realpath(path.join(dest, "newlink")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  expect(actual).not.toBe(await realpath(outside));
});
