import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishNoOverwrite, volumePublishOperations, type PublishDestination } from "../../../src/sdk/internal/noClobberPublish.js";
import { nodeFileSystem, Volume } from "../../../src/sdk/internal/volume.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const unsupported = async (): Promise<never> => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); };
afterEach(() => vi.useRealTimers());

describe("exclusive publication through the actual volume owner", () => {
  it.each(["cancel", "timeout"])("removes a late-created claim after physical close on %s", async (ending) => {
    const root = await mkdtemp(path.join(tmpdir(), "zipkit-claim-open-"));
    const source = path.join(root, "source.tmp");
    const output = path.join(root, "output.zip");
    await writeFile(source, "complete source");
    const open = gate(), opened = gate(), close = gate(), closing = gate();
    const controller = new AbortController();
    let physicalClose = false;
    const volume = new Volume({
      ...nodeFileSystem, link: unsupported,
      open: async (file, flags, mode) => {
        if (file !== output) return nodeFileSystem.open(file, flags, mode);
        opened.release();
        await open.promise;
        const handle = await nodeFileSystem.open(file, flags, mode);
        return { ...handle, close: async () => {
          closing.release(); await close.promise; await handle.close(); physicalClose = true;
        } };
      },
    }, 50, controller.signal);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const work = publishNoOverwrite(source, output, controller.signal, volumePublishOperations(volume));
    const result = work.catch((error: unknown) => error);
    try {
      await opened.promise;
      if (ending === "cancel") controller.abort();
      else await vi.advanceTimersByTimeAsync(50);
      expect(await result).toHaveProperty("name", ending === "cancel" ? "AbortError" : "StallError");
      open.release();
      await closing.promise;
      expect(existsSync(output)).toBe(true);
      // The caller may stop waiting; the claim may not be unlinked before close.
      await vi.advanceTimersByTimeAsync(50);
      expect(existsSync(output)).toBe(true);
      close.release();
      vi.useRealTimers();
      await vi.waitFor(() => expect(existsSync(output)).toBe(false));
      expect(physicalClose).toBe(true);
      expect(await readFile(source, "utf8")).toBe("complete source");
    } finally {
      open.release(); close.release(); vi.useRealTimers();
      await result;
      await vi.waitFor(() => expect(physicalClose).toBe(true));
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])("joins a late FAT-like write and preserves a replacement winner: %s", async (replace) => {
    const root = await mkdtemp(path.join(tmpdir(), "zipkit-claim-write-"));
    const source = path.join(root, "source.tmp");
    const output = path.join(root, "output.zip");
    await writeFile(source, "complete source");
    const writing = gate(), write = gate();
    const controller = new AbortController();
    let written = false, closed = false, replacement = false;
    const volume = new Volume({
      ...nodeFileSystem, link: unsupported,
      open: async (file, flags, mode) => {
        const handle = await nodeFileSystem.open(file, flags, mode);
        if (file !== output) return handle;
        return {
          ...handle,
          write: async (...args) => {
            writing.release(); await write.promise;
            const result = await handle.write(...args); written = true; return result;
          },
          stat: async () => ({ ...await handle.stat(), dev: 1n, ino: written ? 2n : 1n }),
          close: async () => { await handle.close(); closed = true; },
        };
      },
      lstat: async (file) => file === output
        ? { ...await nodeFileSystem.lstat(file), dev: 1n, ino: replacement ? 99n : written ? 2n : 1n }
        : nodeFileSystem.lstat(file),
    }, 50, controller.signal);
    let destination: PublishDestination | undefined;
    const operations = volumePublishOperations(volume);
    const openExclusive = operations.openExclusive;
    operations.openExclusive = async (file) => { destination = await openExclusive(file); return destination; };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const work = publishNoOverwrite(source, output, controller.signal, operations);
    const result = work.catch((error: unknown) => error);
    try {
      await writing.promise;
      controller.abort();
      await vi.advanceTimersByTimeAsync(50);
      expect(await result).toHaveProperty("name", "AbortError");
      expect(closed).toBe(false);
      if (replace) {
        await unlink(output); await writeFile(output, "winner"); replacement = true;
      }
      write.release();
      vi.useRealTimers();
      await destination!.discard();
      expect(closed).toBe(true);
      if (replace) expect(await readFile(output, "utf8")).toBe("winner");
      else await vi.waitFor(() => expect(existsSync(output)).toBe(false));
    } finally {
      write.release(); vi.useRealTimers(); await result;
      await destination?.discard();
      await vi.waitFor(() => expect(closed).toBe(true));
      await rm(root, { recursive: true, force: true });
    }
  });
});
