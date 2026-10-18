import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pLimit from "p-limit";
import { expect, it, vi, onTestFinished } from "vitest";
import { extractArchive } from "../../src/extract/extract.ts";
import { nodeFileSystem, Volume, volumeWorkPending } from "../../src/internal/volume.ts";
import { createLogger } from "../../src/log/logger.ts";
import { buildZipFile } from "../helpers/writeZip.ts";
import { fileSymlinksSupported } from "../helpers/symlink.ts";

it.runIf(fileSymlinksSupported).each([
  { overwrite: false, cancel: true }, { overwrite: false, cancel: false },
  { overwrite: true, cancel: true }, { overwrite: true, cancel: false },
])("owns restored link creation through physical settlement: $overwrite/$cancel", async ({ overwrite, cancel }) => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-symlink-settlement-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const dest = path.join(root, "dest");
  await mkdir(dest);
  const target = path.join(dest, "link");
  if (overwrite) await writeFile(target, "original");
  const data = Buffer.from("missing.txt");
  const archive = await buildZipFile([{ name: "link", type: "symlink", method: "store", raw: data,
    uncompressedSize: data.length, mode: 0o120777, mtimeNs: 1_577_836_800_000_000_000n,
    atimeNs: 1_577_836_800_000_000_000n, birthtimeNs: 1_577_836_800_000_000_000n }], { timeZone: "UTC", chunkSize: 65536 });
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const seen = new Promise<void>((resolve) => { started = resolve; });
  const controller = new AbortController();
  const volume = new Volume({ ...nodeFileSystem, symlink: async (value, file) => {
    started(); await held; await nodeFileSystem.symlink(value, file);
  } }, cancel ? 1000 : 50, controller.signal);
  let settled = false;
  const work = extractArchive({ archive: archive.path, dest, overwrite }, { volume, signal: controller.signal, chunkSize: 65536,
    limit: pLimit(1), logger: createLogger() });
  const outcome = work.then((result) => ({ result }), (error: unknown) => ({ error }));
  void outcome.then(() => { settled = true; });
  try {
    await seen;
    if (cancel) controller.abort();
    if (cancel && !overwrite) {
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      expect(await outcome).toMatchObject({ result: { wrote: true } });
    } else {
      expect(await outcome).toMatchObject({ error: cancel
        ? { code: "aborted" } : { code: "io.stalled", effect: overwrite ? "none" : "unknown" } });
      expect(volumeWorkPending()).toBe(true);
      release();
    }
    await vi.waitFor(() => expect(volumeWorkPending()).toBe(false));
    expect(await readdir(dest)).toEqual(["link"]);
    expect((await lstat(target)).isSymbolicLink()).toBe(!overwrite);
  } finally {
    release(); await outcome;
    await vi.waitFor(() => expect(volumeWorkPending()).toBe(false));
  }
});
