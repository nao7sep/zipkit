import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeFileSystem, Volume, type FileSystemPort, type DirEntry } from "../../src/internal/volume.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "zipkit-volume-mode-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const volume = (port: FileSystemPort = nodeFileSystem): Volume => new Volume(port, 30_000);

describe("ordinary staging and replacement modes", () => {
  it.skipIf(process.platform === "win32")("stages with owner access before bytes and restores the ordinary new-file mode before publication", async () => {
    const temp = path.join(root, "stage.tmp");
    const owner = volume();
    const handle = await owner.createTemp(temp);
    try {
      expect((await stat(temp)).mode & 0o777).toBe(0o600 & ~process.umask());
      await handle.writeAll(Buffer.from("complete"), 0);
    } finally { await handle.close(); }
    await owner.prepareNewMode(temp);
    expect((await stat(temp)).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  it("an exclusive staging collision leaves the other file intact", async () => {
    const temp = path.join(root, "stage.tmp");
    await writeFile(temp, "other");
    await expect(volume().createTemp(temp)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(temp, "utf8")).toBe("other");
  });

  it.skipIf(process.platform === "win32")("keeps an existing target's ordinary permission bits", async () => {
    const target = path.join(root, "target");
    const temp = path.join(root, "stage.tmp");
    await writeFile(target, "old");
    await chmod(target, 0o640);
    const owner = volume();
    const handle = await owner.createTemp(temp);
    await handle.close();
    expect(await owner.keepMode(target, temp)).toBe(true);
    expect((await stat(temp)).mode & 0o777).toBe(0o640);
  });

  it.each(["EPERM", "EACCES", "EIO"])("propagates %s while preparing replacement permissions", async (code) => {
    const target = path.join(root, "target");
    await writeFile(target, "old");
    const error = Object.assign(new Error("mode failed"), { code });
    const owner = volume({ ...nodeFileSystem, chmod: async () => { throw error; } });
    await expect(owner.keepMode(target, path.join(root, "stage.tmp"))).rejects.toBe(error);
    expect(await readFile(target, "utf8")).toBe("old");
  });

  it.each(["ENOSYS", "ENOTSUP", "EOPNOTSUPP"])("tolerates explicit %s mode incapability", async (code) => {
    const target = path.join(root, "target");
    await writeFile(target, "old");
    const owner = volume({ ...nodeFileSystem, chmod: async () => { throw Object.assign(new Error("unsupported"), { code }); } });
    await expect(owner.keepMode(target, path.join(root, "stage.tmp"))).resolves.toBe(true);
    await expect(owner.prepareNewMode(path.join(root, "stage.tmp"))).resolves.toBeUndefined();
  });

  it("does not treat a target stat failure as an absent file", async () => {
    const error = Object.assign(new Error("read denied"), { code: "EACCES" });
    const owner = volume({ ...nodeFileSystem, stat: async () => { throw error; } });
    await expect(owner.keepMode(path.join(root, "target"), path.join(root, "stage.tmp"))).rejects.toBe(error);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("incremental directory lifetime", () => {
  afterEach(() => vi.useRealTimers());

  it("closes a directory when its consumer stops before EOF", async () => {
    const close = vi.fn(async () => {});
    const read = vi.fn(async () => ({ name: "one", isDirectory: () => false }));
    const owner = volume({ ...nodeFileSystem, openDirectory: async () => ({ read, close }) });
    for await (const entry of owner.directoryEntries(root)) {
      expect(entry.name).toBe("one");
      break;
    }
    expect(read).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await owner.whenSettled();
  });

  it("closes an opened directory that arrives after cancellation and owns its late close", async () => {
    vi.useFakeTimers();
    const opened = deferred<{ read: () => Promise<DirEntry | null>; close: () => Promise<void> }>();
    const closing = deferred<void>();
    const close = vi.fn(() => closing.promise);
    const controller = new AbortController();
    const owner = new Volume({ ...nodeFileSystem, openDirectory: () => opened.promise }, 100, controller.signal);
    const work = owner.directoryEntries(root).next();
    const rejected = expect(work).rejects.toHaveProperty("code", "operation.cancelled");
    controller.abort();
    await rejected;
    let settled = false;
    const physical = owner.whenSettled().then(() => { settled = true; });
    opened.resolve({ read: async () => null, close });
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    closing.resolve();
    await physical;
    expect(settled).toBe(true);
  });

  it.each(["cancel", "timeout"])("waits for the actual held read before close after %s", async (failure) => {
    vi.useFakeTimers();
    const held = deferred<DirEntry | null>();
    const started = deferred<void>();
    let reading = false;
    const close = vi.fn(async () => { expect(reading).toBe(false); });
    const controller = new AbortController();
    const owner = new Volume({ ...nodeFileSystem, openDirectory: async () => ({
      read: () => {
        reading = true;
        started.resolve();
        return held.promise.finally(() => { reading = false; });
      }, close,
    }) }, 100, controller.signal);
    const work = owner.directoryEntries(root).next();
    const rejected = expect(work).rejects.toHaveProperty("code", failure === "cancel" ? "operation.cancelled" : "io.stalled");
    await started.promise;
    if (failure === "cancel") controller.abort();
    else await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(close).not.toHaveBeenCalled();
    let settled = false;
    const physical = owner.whenSettled().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    held.resolve(null);
    await physical;
    expect(close).toHaveBeenCalledOnce();
    expect(settled).toBe(true);
  });

  it("keeps the original read failure when cleanup also fails", async () => {
    const error = Object.assign(new Error("unreadable"), { code: "EACCES" });
    const owner = volume({ ...nodeFileSystem, openDirectory: async () => ({
      read: async () => { throw error; }, close: async () => { throw new Error("close failed"); },
    }) });
    await expect(owner.directoryEntries(root).next()).rejects.toBe(error);
    await owner.whenSettled();
  });
});
