import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ZipKit } from "../../../src/sdk/zipkit.js";
import { nodeFileSystem, Volume, volumeWorkPending, type FileSystemPort } from "../../../src/sdk/internal/volume.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

it("write delivers its settlement observer before rejection and retains a late claim through physical cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-write-settlement-"));
  const input = path.join(root, "input.txt");
  const output = path.join(root, "archive.zip");
  const open = gate(), opened = gate(), close = gate(), closing = gate(), closed = gate();
  const controller = new AbortController();
  let openStarted = false;
  let physicallyClosed = false;
  let checkedIdentity = false;
  let removed = false;
  const port: FileSystemPort = {
    ...nodeFileSystem,
    link: async () => { throw Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }); },
    open: async (file, flags, mode) => {
      if (file !== output) return nodeFileSystem.open(file, flags, mode);
      openStarted = true;
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
    lstat: async (file) => {
      const result = await nodeFileSystem.lstat(file);
      if (file === output && physicallyClosed) checkedIdentity = true;
      return result;
    },
    unlink: async (file) => {
      if (file === output) {
        expect(physicallyClosed).toBe(true);
        expect(checkedIdentity).toBe(true);
      }
      await nodeFileSystem.unlink(file);
      if (file === output) removed = true;
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
  const zip = new TestZipKit({ sessionLog: false });
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
    await Promise.race([opened.promise, outcome.then(() => { throw new Error("write ended before claiming its output"); })]);
    controller.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(order).toEqual(["observer", "rejection"]);
    expect(settlement).toBeDefined();
    expect(settled).toBe(false);
    expect(existsSync(output)).toBe(false);
    expect(volumeWorkPending()).toBe(true);

    open.release();
    await closing.promise;
    expect(existsSync(output)).toBe(true);
    // Expire the late claim's bounded discard wait while its raw close remains held.
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);
    expect(removed).toBe(false);
    expect(volumeWorkPending()).toBe(true);

    close.release();
    vi.useRealTimers();
    await settlement;
    expect(settled).toBe(true);
    expect(removed).toBe(true);
    expect(volumeWorkPending()).toBe(false);
    expect(existsSync(output)).toBe(false);
    expect(await readFile(input, "utf8")).toBe("complete source");
  } finally {
    open.release(); close.release();
    vi.useRealTimers();
    await outcome;
    if (openStarted) await closed.promise;
    await Promise.all(volumes.map((volume) => volume.whenSettled()));
    await settlement;
    await rm(root, { recursive: true, force: true });
  }
});

it("create delivers a settled observer before returning a successful archive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-create-settlement-"));
  const input = path.join(root, "input.txt");
  const output = path.join(root, "archive.zip");
  const zip = new ZipKit({ sessionLog: false });
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
    expect(volumeWorkPending()).toBe(false);
    expect((await zip.extract({ archive: output, dryRun: true, checkMetadata: true })).reportOk).toBe(true);
  } finally {
    await settlement;
    await rm(root, { recursive: true, force: true });
  }
});
