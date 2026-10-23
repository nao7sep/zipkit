import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ZipKit } from "../src/zipkit.ts";
import { ZipKitError } from "../src/errors.ts";
import { nodeFileSystem, Volume, type FileSystemPort } from "../src/internal/volume.ts";
import { createDirectoryLink, createFileLink, fileSymlinksSupported } from "./helpers/symlink.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "zipkit-lifecycle-")); });
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });
function withPort(port: FileSystemPort, concurrency = 2, timeout = 30_000) {
  return new class extends ZipKit {
    constructor() { super({ concurrency }); }
    override volume(signal?: AbortSignal) { return new Volume(port, timeout, signal); }
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

it("stops queued scan admission on failure and joins issued logical reads", async () => {
  const input = path.join(root, "input"); await mkdir(input);
  for (let i = 0; i < 12; i++) await writeFile(path.join(input, `${i}.txt`), "x");
  const fail = gate(), held = gate(), two = gate();
  const starts: string[] = [];
  const zip = withPort({ ...nodeFileSystem, lstat: async (file) => {
    if (path.dirname(file) !== input) return nodeFileSystem.lstat(file);
    starts.push(file);
    if (starts.length === 1) { await fail.promise; throw Object.assign(new Error("denied"), { code: "EACCES" }); }
    two.release(); await held.promise; return nodeFileSystem.lstat(file);
  } });
  let terminal = false;
  const outcome = zip.plan({ inputs: [input], output: path.join(root, "out.zip") }).catch((error: unknown) => error).finally(() => { terminal = true; });
  try {
    await two.promise; fail.release(); await turn();
    expect(terminal).toBe(false);
    expect(starts).toHaveLength(2);
  } finally { fail.release(); held.release(); await outcome; }
  expect(await outcome).toMatchObject({ code: "path.denied", subject: starts[0] });
  expect(starts).toHaveLength(2);
});

it("does not open sibling directories after a directory read fails", async () => {
  const input = path.join(root, "input"), a = path.join(input, "a"), b = path.join(input, "b");
  await mkdir(a, { recursive: true }); await mkdir(b);
  const original = new ZipKitError("io.failed", "listing failed", { subject: a });
  const opened: string[] = [];
  const zip = withPort({ ...nodeFileSystem, openDirectory: async (file) => {
    opened.push(file);
    if (file !== input) throw original;
    return nodeFileSystem.openDirectory(file);
  } });
  await expect(zip.plan({ inputs: [input], output: path.join(root, "out.zip") })).rejects.toBe(original);
  expect(opened).toHaveLength(2);
});

it("bounds pathKinds admission using the instance concurrency and preserves order", async () => {
  const input = path.join(root, "input"); await writeFile(input, "x");
  const held = gate(), started = gate(); let active = 0, peak = 0;
  const zip = withPort({ ...nodeFileSystem, lstat: async () => {
    peak = Math.max(peak, ++active); started.release(); await held.promise;
    try { return await nodeFileSystem.lstat(input); } finally { active--; }
  } });
  const paths = Array.from({ length: 40 }, (_, i) => path.join(root, `path-${i}`));
  const result = zip.pathKinds(paths);
  try { await started.promise; await turn(); expect(peak).toBeLessThanOrEqual(2); }
  finally { held.release(); await result; }
  expect((await result).map((entry) => entry.path)).toEqual(paths);
});

it("cancels bounded pathKinds work without admitting another path and retains native settlement", async () => {
  const input = path.join(root, "input"); await writeFile(input, "x");
  const held = gate(), started = gate(); let calls = 0, settled = false;
  const controller = new AbortController();
  const zip = withPort({ ...nodeFileSystem, lstat: async () => {
    if (++calls === 2) started.release();
    await held.promise; return nodeFileSystem.lstat(input);
  } });
  let physical: Promise<void> | undefined;
  const outcome = zip.pathKinds(Array.from({ length: 20 }, (_, i) => path.join(root, `${i}`)), {
    signal: controller.signal,
    onPhysicalSettlement: (pending) => { physical = pending; void pending.then(() => { settled = true; }); },
  }).catch((error: unknown) => error);
  try {
    await started.promise; controller.abort();
    expect(await outcome).toMatchObject({ code: "operation.cancelled" });
    expect(calls).toBe(2); expect(settled).toBe(false);
  } finally { held.release(); await outcome; await physical; }
  expect(settled).toBe(true); expect(calls).toBe(2);
});

it.each([false, true])("excludes own overlapping fallback publication through physical settlement (stall=%s)", async (stall) => {
  const input = path.join(root, "input.txt"), output = path.join(root, "out.zip");
  await writeFile(input, "archive bytes");
  const rename = gate(), entered = gate(); let renames = 0;
  const zip = withPort({ ...nodeFileSystem,
    link: async () => { throw Object.assign(new Error("no links"), { code: "ENOTSUP" }); },
    rename: async (from, to) => {
      if (++renames === 1) {
        if (stall) await nodeFileSystem.rename(from, to);
        entered.release(); await rename.promise;
        if (stall) return;
      }
      await nodeFileSystem.rename(from, to);
    },
  }, 2, 50);
  const first = await zip.plan({ inputs: [input], output });
  const alias = path.join(root, "alias");
  await createDirectoryLink(root, alias);
  const second = await new ZipKit().plan({ inputs: [input], output: path.join(alias, "out.zip"), overwrite: stall });
  let settlement: Promise<void> | undefined;
  if (stall) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const outcome = zip.write(first, { onPhysicalSettlement: (physical) => { settlement = physical; } }).catch((error: unknown) => error);
  try {
    await entered.promise;
    if (stall) { await vi.advanceTimersByTimeAsync(50); expect(await outcome).toMatchObject({ code: "io.stalled" }); vi.useRealTimers(); }
    const other = await new ZipKit().write(second);
    expect(other).toMatchObject({ mode: "plan", writable: false, findings: expect.arrayContaining([expect.objectContaining({ rule: "output.busy", severity: "error" })]) });
    expect(renames).toBe(1);
  } finally { rename.release(); vi.useRealTimers(); await outcome; await settlement; }
  expect((await new ZipKit().verify({ archive: output, manifest: true })).ok).toBe(true);
  expect(await readFile(input, "utf8")).toBe("archive bytes");
});
