import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ZipKit } from "../../src/zipkit.ts";
import { nodeFileSystem, Volume, type FileSystemPort } from "../../src/internal/volume.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

it("write delivers its settlement observer before rejection and retains a late temp file through physical cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-write-settlement-"));
  const input = path.join(root, "input.txt");
  const output = path.join(root, "archive.zip");
  const open = gate(), opened = gate(), close = gate(), closing = gate(), closed = gate();
  const controller = new AbortController();
  let temp: string | undefined;
  let physicallyClosed = false;
  let removed = false;
  const port: FileSystemPort = {
    ...nodeFileSystem,
    open: async (file, flags, mode) => {
      if (!file.endsWith(".tmp")) return nodeFileSystem.open(file, flags, mode);
      temp = file;
      opened.release();
      await open.promise;
      const handle = await nodeFileSystem.open(file, flags, mode);
      return { ...handle, close: async () => {
        closing.release();
        await close.promise;
        await handle.close();
        physicallyClosed = true;
        closed.release();
      } };
    },
    rm: async (file) => {
      await nodeFileSystem.rm(file);
      if (file === temp && physicallyClosed) removed = true;
    },
  };
  const volumes: Volume[] = [];
  class TestZipKit extends ZipKit {
    override volume(signal?: AbortSignal): Volume {
      const volume = new Volume(port, 50, signal);
      volumes.push(volume);
      return volume;
    }
  }
  const zip = new TestZipKit();
  const order: string[] = [];
  let settlement: Promise<void> | undefined;
  let settled = false;
  let outcome: Promise<unknown> | undefined;
  try {
    await writeFile(input, "complete source");
    const plan = await zip.plan({ inputs: [input], output });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    outcome = zip.write(plan, {
      signal: controller.signal,
      onPhysicalSettlement: (physical) => {
        order.push("observer");
        settlement = physical;
        void physical.then(() => { settled = true; });
      },
    }).catch((error: unknown) => { order.push("rejection"); return error; });
    await Promise.race([opened.promise, outcome.then(() => { throw new Error("write ended before creating its temp file"); })]);
    controller.abort();
    expect(await outcome).toMatchObject({ code: "operation.cancelled" });
    expect(order).toEqual(["observer", "rejection"]);
    expect(settlement).toBeDefined();
    expect(settled).toBe(false);

    // The abandoned create lands late and makes the temp file.
    open.release();
    await closing.promise;
    expect(existsSync(temp!)).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);
    expect(removed).toBe(false);

    close.release();
    vi.useRealTimers();
    await settlement;
    expect(settled).toBe(true);
    expect(removed).toBe(true);
    expect(existsSync(temp!)).toBe(false);
    expect(existsSync(output)).toBe(false);
    expect(await readFile(input, "utf8")).toBe("complete source");
  } finally {
    open.release(); close.release();
    vi.useRealTimers();
    await outcome;
    if (temp !== undefined) await closed.promise;
    await Promise.all(volumes.map((volume) => volume.whenSettled()));
    await settlement;
    await rm(root, { recursive: true, force: true });
  }
});

it("create delivers a settled observer before returning a successful archive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-create-settlement-"));
  const input = path.join(root, "input.txt");
  const output = path.join(root, "archive.zip");
  const zip = new ZipKit();
  let settlement: Promise<void> | undefined;
  let calls = 0;
  try {
    await writeFile(input, "complete source");
    const result = await zip.create({ inputs: [input], output }, {
      onPhysicalSettlement: (physical) => { calls++; settlement = physical; },
    });
    expect(calls).toBe(1);
    expect(settlement).toBeDefined();
    await settlement;
    expect(result.output).toBe(output);
    expect(existsSync(output)).toBe(true);
    expect((await zip.verify({ archive: output, manifest: true })).ok).toBe(true);
  } finally {
    await settlement;
    await rm(root, { recursive: true, force: true });
  }
});
