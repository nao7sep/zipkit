import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ZipKit } from "../../src/zipkit.ts";
import { nodeFileSystem, Volume, type FileSystemPort } from "../../src/internal/volume.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { release, promise };
}
afterEach(() => vi.useRealTimers());
const lanes = ["rename", "link", "copy"] as const;

it.each(lanes)("%s publication keeps its complete archive when cancellation accompanies a directory flush failure", async (lane) => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-durable-archive-"));
  const input = path.join(root, "source.txt"), output = path.join(root, "archive.zip");
  const error = Object.assign(new Error("EIO /private/staging SENTINEL"), { code: "EIO" });
  const controller = new AbortController();
  const port: FileSystemPort = { ...nodeFileSystem,
    syncDirectory: async () => { controller.abort(); throw error; },
    ...(lane === "copy" ? { link: async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); } } : {}),
  };
  class TestZipKit extends ZipKit { override volume(signal?: AbortSignal) { return new Volume(port, 30_000, signal); } }
  const zip = new TestZipKit();
  try {
    await writeFile(input, "preserved original");
    const plan = await zip.plan({ inputs: [input], output, overwrite: lane === "rename" });
    await expect(zip.write(plan, { signal: controller.signal })).rejects.toMatchObject({ code: "write.durability", effect: "unknown", subject: output, cause: error });
    expect(await readFile(input, "utf8")).toBe("preserved original");
    // Read with the normal SDK, proving the public output is a complete ZIP.
    expect((await new ZipKit().verify({ archive: output, manifest: true })).ok).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(lanes)("%s publication ignores cancellation during its flush and retains physical ownership after timeout", async (lane) => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-durable-late-"));
  const input = path.join(root, "source.txt"), output = path.join(root, "archive.zip");
  const entered = gate(), flush = gate();
  const controller = new AbortController();
  const port: FileSystemPort = { ...nodeFileSystem,
    syncDirectory: async (directory) => { entered.release(); await flush.promise; await nodeFileSystem.syncDirectory(directory); },
    ...(lane === "copy" ? { link: async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); } } : {}),
  };
  class TestZipKit extends ZipKit { override volume(signal?: AbortSignal) { return new Volume(port, 50, signal); } }
  const zip = new TestZipKit();
  let settlement: Promise<void> | undefined, physicallySettled = false;
  let outcome: Promise<unknown> | undefined;
  try {
    await writeFile(input, "complete original");
    const plan = await zip.plan({ inputs: [input], output, overwrite: lane === "rename" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    outcome = zip.write(plan, { signal: controller.signal, onPhysicalSettlement: (pending) => {
      settlement = pending; void pending.then(() => { physicallySettled = true; });
    } }).catch((error: unknown) => error);
    await Promise.race([entered.promise, outcome.then(() => { throw new Error("write stopped before publication flush"); })]);
    controller.abort();
    await vi.advanceTimersByTimeAsync(50);
    expect(await outcome).toMatchObject({ code: "io.stalled", effect: "unknown", subject: output });
    expect(physicallySettled).toBe(false);
    expect(settlement).toBeDefined();
    flush.release(); await settlement;
    expect(physicallySettled).toBe(true);
    vi.useRealTimers();
    expect((await new ZipKit().verify({ archive: output, manifest: true })).ok).toBe(true);
  } finally { flush.release(); vi.useRealTimers(); await outcome; await settlement; await rm(root, { recursive: true, force: true }); }
});

it("synchronizes the links of newly created output ancestors after publication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-durable-parents-"));
  const input = path.join(root, "input.txt");
  const output = path.join(root, "new", "nested", "archive.zip");
  const synced: string[] = [];
  const port: FileSystemPort = { ...nodeFileSystem, syncDirectory: async (directory) => { synced.push(directory); } };
  class TestZipKit extends ZipKit { override volume(signal?: AbortSignal) { return new Volume(port, 30_000, signal); } }
  try {
    await writeFile(input, "original");
    await new TestZipKit().create({ inputs: [input], output });
    expect(synced).toEqual([path.dirname(output), path.join(root, "new"), root]);
    synced.length = 0;
    await new TestZipKit().create({ inputs: [input], output, overwrite: true });
    expect(synced).toEqual([path.dirname(output)]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("retains the archive and reports uncertainty when an ancestor flush fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-durable-ancestor-"));
  const input = path.join(root, "input.txt");
  const output = path.join(root, "new", "nested", "archive.zip");
  const failure = Object.assign(new Error("ancestor flush failed"), { code: "EIO" });
  const synced: string[] = [];
  const port: FileSystemPort = { ...nodeFileSystem, syncDirectory: async (directory) => {
    synced.push(directory);
    if (directory === path.join(root, "new")) throw failure;
  } };
  class TestZipKit extends ZipKit { override volume(signal?: AbortSignal) { return new Volume(port, 30_000, signal); } }
  try {
    await writeFile(input, "original");
    await expect(new TestZipKit().create({ inputs: [input], output })).rejects.toMatchObject({
      code: "write.durability", effect: "unknown", subject: output, cause: failure,
    });
    expect(synced).toEqual([path.dirname(output), path.join(root, "new")]);
    expect(await readFile(input, "utf8")).toBe("original");
    expect((await new ZipKit().verify({ archive: output, manifest: true })).ok).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
