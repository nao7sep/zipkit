import { lstat, mkdir, mkdtemp, realpath, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createLinkTargetGuard } from "../../../src/sdk/extract/linkTargets.js";
import { nodeFileSystem, Volume } from "../../../src/sdk/internal/volume.js";
import { fileSymlinksSupported } from "../../helpers/symlink.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-link-targets-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const dest = path.join(root, "dest");
  await mkdir(dest);
  for (const name of ["inner", "escape"]) await mkdir(path.join(dest, name));
  await mkdir(path.join(root, "escape"));
  return { root, dest };
}

it.runIf(fileSymlinksSupported).each([
  ["deep", "DEEP"], ["σ", "ς"], ["ß", "ss"], ["ẞ", "ß"],
])("uses physical namespace aliases for an existing %s/%s prefix", async (name, alias) => {
  const { root, dest } = await fixture();
  await symlink("inner", path.join(dest, name));
  await symlink(`${alias}/../escape`, path.join(dest, "alias"));
  const original = await lstat(path.join(dest, name));
  const alternate = await lstat(path.join(dest, alias)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const same = alternate !== null && alternate.ino === original.ino && alternate.dev === original.dev;
  const volume = new Volume(nodeFileSystem, 1000);
  const guard = createLinkTargetGuard(volume, dest);
  const first = await guard.prepare(path.join(dest, "first"), "alias", true);
  expect(first).not.toBeNull();
  await volume.publishSymlink("alias", path.join(dest, "first")); first!();
  const later = await guard.prepare(path.join(dest, name), ".", true);
  expect(later === null).toBe(same);
  if (later) {
    await unlink(path.join(dest, name)); await volume.publishSymlink(".", path.join(dest, name)); later();
  }
  const resolved = await realpath(path.join(dest, "first")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  expect(resolved).not.toBe(await realpath(path.join(root, "escape")));
});

it.runIf(fileSymlinksSupported).each([
  ["σ", "ς"], ["ss", "ß"], ["ẞ", "ß"],
])("keeps an unresolved Unicode prefix safe before publishing %s/%s", async (name, alias) => {
  const { dest } = await fixture();
  await symlink(`${alias}/../escape`, path.join(dest, "alias"));
  const volume = new Volume(nodeFileSystem, 1000);
  const guard = createLinkTargetGuard(volume, dest);
  const first = await guard.prepare(path.join(dest, "first"), "alias", true);
  expect(first).not.toBeNull();
  await volume.publishSymlink("alias", path.join(dest, "first")); first!();
  await expect(guard.prepare(path.join(dest, name), ".", true)).resolves.toBeNull();
  await expect(lstat(path.join(dest, name))).rejects.toHaveProperty("code", "ENOENT");
  await expect(realpath(path.join(dest, "first"))).rejects.toHaveProperty("code", "ENOENT");
});

it.runIf(fileSymlinksSupported).each(["missing", "missing/tail"])("keeps unrelated ASCII dangling links linear: %s", async (suffix) => {
  const { dest } = await fixture();
  let reads = 0;
  const volume = new Volume({ ...nodeFileSystem, lstat: async (file) => {
    reads++; return nodeFileSystem.lstat(file);
  } }, 1000);
  const guard = createLinkTargetGuard(volume, dest);
  const count = 200;
  for (let i = 0; i < count; i++) {
    const target = path.join(dest, `link-${i}`), value = `${suffix}-${i}`;
    const accepted = await guard.prepare(target, value, true);
    expect(accepted).not.toBeNull();
    await volume.publishSymlink(value, target); accepted!();
  }
  // An earlier link is rechecked only for a related pathname/physical alias.
  // Rescanning every earlier dangling link would require tens of thousands.
  expect(reads).toBeLessThanOrEqual(count * 6);
});

it.runIf(fileSymlinksSupported)("accepts distinct ASCII names beside a dangling prefix with an outward suffix", async () => {
  const { root, dest } = await fixture();
  await symlink(path.join(root, "escape"), path.join(dest, "outside"));
  const volume = new Volume(nodeFileSystem, 1000);
  const guard = createLinkTargetGuard(volume, dest);
  const accepted = await guard.prepare(path.join(dest, "first"), "missing/outside", true);
  expect(accepted).not.toBeNull();
  await volume.publishSymlink("missing/outside", path.join(dest, "first")); accepted!();
  expect(await guard.prepare(path.join(dest, "other"), ".", true)).not.toBeNull();
  expect(await guard.prepare(path.join(dest, "missing"), ".", true)).toBeNull();
});

it.runIf(fileSymlinksSupported)("indexes physical Unicode spellings once across repeated replacements", async () => {
  const { dest } = await fixture();
  const count = 100;
  for (let i = 0; i < count; i++) await symlink("missing", path.join(dest, `café-${i}`.normalize("NFD")));
  let reads = 0, listings = 0;
  const volume = new Volume({ ...nodeFileSystem,
    lstat: async (file) => { reads++; return nodeFileSystem.lstat(file); },
    readdir: async (file) => { listings++; return nodeFileSystem.readdir(file); },
  }, 1000);
  const guard = createLinkTargetGuard(volume, dest);
  for (let i = 0; i < count; i++) {
    const target = path.join(dest, `café-${i}`.normalize("NFC"));
    const accepted = await guard.prepare(target, "another-missing", true);
    expect(accepted).not.toBeNull();
    const staged = path.join(dest, `.stage-${i}`);
    await volume.stageSymlink("another-missing", staged);
    await volume.publishRename(staged, target); accepted!();
  }
  // Native normalization aliases previously caused a complete physical folder
  // scan for every replacement. On a distinct-name volume no alias scan is needed.
  expect(reads).toBeLessThanOrEqual(count * 8 + 10);
  expect(listings).toBeLessThanOrEqual(1);
});
