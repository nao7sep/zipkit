import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ZipKit } from "../../../src/sdk/zipkit.js";
import { nodeFileSystem, Volume, type FileSystemPort } from "../../../src/sdk/internal/volume.js";

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
    await expect(zip.write(plan, { signal: controller.signal })).rejects.toMatchObject({ code: "write.durability", path: output, cause: error });
    expect(await readFile(input, "utf8")).toBe("preserved original");
    // Read with the normal SDK, proving the public output is a complete ZIP.
    expect((await new ZipKit().extract({ archive: output, dryRun: true, checkMetadata: true })).reportOk).toBe(true);
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
    expect(await outcome).toMatchObject({ code: "io.stalled", committing: true, path: output });
    expect(physicallySettled).toBe(false);
    expect(settlement).toBeDefined();
    flush.release(); await settlement;
    expect(physicallySettled).toBe(true);
    vi.useRealTimers();
    expect((await new ZipKit().extract({ archive: output, dryRun: true, checkMetadata: true })).reportOk).toBe(true);
  } finally { flush.release(); vi.useRealTimers(); await outcome; await settlement; await rm(root, { recursive: true, force: true }); }
});
