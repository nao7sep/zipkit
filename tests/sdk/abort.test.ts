/**
 * Abort propagation through the SDK: the signal actually flowing through the
 * scan → write pipeline — an already-aborted signal stops plan() at the scan
 * edge, and an abort raised mid-write rejects with AbortError and leaves no
 * output behind.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AbortError, ZipKit } from "../../src/sdk/index.js";
import { ZipWriter } from "../../src/sdk/write/zipWriter.js";
import { parseZip, readEntryData } from "../../src/sdk/extract/zipReader.js";
import pLimit from "p-limit";
import { extractArchive } from "../../src/sdk/extract/extract.js";
import { writeArchive } from "../../src/sdk/write/write.js";
import { nodeFileSystem, Volume, type FileSystemPort } from "../../src/sdk/internal/volume.js";
import { createLogger } from "../../src/sdk/log/logger.js";
import { buildZipFile } from "../helpers/writeZip.js";
import { openRead, realVolume } from "../helpers/volume.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zipkit-abort-"));
});

afterEach(async () => {
  delete process.env.ZIPKIT_DEBUG;
  await rm(dir, { recursive: true, force: true });
});

async function makeTree(): Promise<string> {
  const proj = path.join(dir, "proj");
  await mkdir(path.join(proj, "sub"), { recursive: true });
  await writeFile(path.join(proj, "a.txt"), "hello");
  await writeFile(path.join(proj, "sub", "b.txt"), "world");
  return proj;
}

describe("abort propagation", () => {
  it("rejects plan() when the signal is already aborted", async () => {
    const proj = await makeTree();
    const controller = new AbortController();
    controller.abort();

    await expect(
      new ZipKit().plan({ inputs: [proj] }, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it("rejects write() when the signal is already aborted", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "abort-write.zip");
    const zip = new ZipKit();

    // The plan→inspect→write flow: plan() with no signal, then a write() whose
    // own call options carry an already-aborted signal. The writer must stop at
    // its first boundary and leave nothing behind.
    const plan = await zip.plan({ inputs: [proj], output });
    const controller = new AbortController();
    controller.abort();

    await expect(zip.write(plan, { signal: controller.signal })).rejects.toBeInstanceOf(AbortError);
    expect(existsSync(output)).toBe(false);
  });

  it("rejects create() when aborted mid-write and writes no output", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "abort.zip");
    const controller = new AbortController();
    const zip = new ZipKit();

    // Abort the instant the write phase begins, via the per-call onProgress hook;
    // the per-entry abort check then trips before any bytes reach disk.
    await expect(
      zip.create(
        { inputs: [proj], output },
        {
          signal: controller.signal,
          onProgress: (event) => {
            if (event.event === "write.start") controller.abort();
          },
        },
      ),
    ).rejects.toBeInstanceOf(AbortError);
    expect(existsSync(output)).toBe(false);
  });

  it("rejects create() aborted at the final entry.written and writes no output", async () => {
    // A single-file archive: the file's entry.written is the last per-entry
    // event, so the loop has no further entry boundary to trip. This exercises
    // the streaming→finalize phase edge — past it the archive would otherwise be
    // finalized and renamed into place despite the cancellation.
    //
    // entry.written is a debug event; enable the developer debug channel so it
    // reaches the onProgress hook the abort trigger watches.
    process.env.ZIPKIT_DEBUG = "1";
    const file = path.join(dir, "only.txt");
    await writeFile(file, "just one file");
    const output = path.join(dir, "last-entry.zip");
    const controller = new AbortController();
    const zip = new ZipKit();

    await expect(
      zip.create(
        { inputs: [file], output },
        {
          signal: controller.signal,
          onProgress: (event) => {
            if (event.event === "entry.written") controller.abort();
          },
        },
      ),
    ).rejects.toBeInstanceOf(AbortError);
    expect(existsSync(output)).toBe(false);
  });

  it("rejects extract() aborted mid-entry and commits no file", async () => {
    // A stored entry sixteen chunks long. The first chunk written to the entry's
    // staging temp raises the abort, so the per-entry pre-walk check has already
    // passed and the copy loop is running: the cancellation lands on the
    // per-chunk sink boundary (not the entry boundary) and no file may be
    // committed.
    const chunkSize = 4096;
    const raw = randomBytes(16 * chunkSize);
    const { path: archive } = await buildZipFile(
      [{ name: "big.bin", type: "file", method: "store", uncompressedSize: raw.length, mtimeNs: 0n, atimeNs: 0n, birthtimeNs: 0n, mode: 0o644, raw }],
      { timeZone: "UTC", chunkSize },
    );
    const dest = path.join(dir, "out");
    const controller = new AbortController();
    let stagedWrites = 0;
    const port: FileSystemPort = {
      ...nodeFileSystem,
      open: async (file, flags) => {
        const handle = await nodeFileSystem.open(file, flags);
        if (!path.basename(file).startsWith(".zk-")) return handle;
        return {
          ...handle,
          write: (buffer, offset, length, position) => {
            stagedWrites++;
            controller.abort();
            return handle.write(buffer, offset, length, position);
          },
        };
      },
    };

    await expect(
      extractArchive(
        { archive, dest },
        { limit: pLimit(1), logger: createLogger(), chunkSize, signal: controller.signal, volume: new Volume(port, 30_000, controller.signal) },
      ),
    ).rejects.toBeInstanceOf(AbortError);
    expect(stagedWrites).toBe(1);
    expect(readdirSync(dest)).toEqual([]);
  });
  it("rejects a write cancelled while a destination write is held, and leaves no temp file once it lands", async () => {
    const proj = path.join(dir, "big");
    await mkdir(proj);
    await writeFile(path.join(proj, "noise.bin"), randomBytes(4 * 1024 * 1024));
    const output = path.join(dir, "held.zip");
    const plan = await new ZipKit().plan({ inputs: [proj], output });
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => { entered = resolve; });
    let writes = 0;
    const port: FileSystemPort = {
      ...nodeFileSystem,
      open: async (file, flags, mode) => {
        const handle = await nodeFileSystem.open(file, flags, mode);
        if (!file.endsWith(".tmp")) return handle;
        return {
          ...handle,
          write: async (buffer, offset, length, position) => {
            // The second chunk to the archive is held, as a stalled destination holds it.
            if (++writes === 2) {
              entered();
              await held;
            }
            return handle.write(buffer, offset, length, position);
          },
        };
      },
    };

    const run = writeArchive(plan, {
      logger: createLogger(),
      chunkSize: 64 * 1024,
      signal: controller.signal,
      volume: new Volume(port, 30_000, controller.signal),
    });
    const outcome = run.then(() => "written", (error: unknown) => error);
    await holding;
    controller.abort();

    expect(await outcome).toBeInstanceOf(AbortError);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readdirSync(dir).sort()).toEqual(["big"]);
  });
});

describe("abort boundaries (unit)", () => {
  it("finalize() stops before the rename when aborted, leaving no archive", async () => {
    // The create() publish boundary: even after the entries stream, a Ctrl-C
    // during the central-directory write / fsync must not rename the temp file
    // into place. There is no progress event in this window, so the guarantee is
    // pinned at the writer seam with an already-aborted signal.
    const output = path.join(dir, "finalize-abort.zip");
    const writer = new ZipWriter(
      output,
      {
        timeZone: "UTC",
        chunkSize: 65536,
      },
      realVolume(),
    );
    await writer.open();
    const controller = new AbortController();
    controller.abort();

    await expect(writer.finalize(false, undefined, controller.signal)).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(existsSync(output)).toBe(false);
    await writer.abort(); // remove the orphaned temp file
  });

  it("readEntryData() stops a deflated entry at the aborting chunk, not after a full drain", async () => {
    // 1 MiB of compressible bytes → one deflated (method 8) entry that inflates
    // to 256 output chunks of 4 KiB. A sink that throws on its first chunk must
    // tear the inflate pipeline down there, not drain the whole entry — so the
    // sink is called a handful of times, not 256.
    const chunkSize = 4096;
    const raw = Buffer.alloc(256 * chunkSize, 0x61);
    const { path: archive } = await buildZipFile(
      [{ name: "big.txt", type: "file", method: "deflate", uncompressedSize: raw.length, mtimeNs: 0n, atimeNs: 0n, birthtimeNs: 0n, mode: 0o644, raw }],
      { timeZone: "UTC", chunkSize },
    );

    const file = await openRead(archive);
    try {
      const parsed = await parseZip(file, statSync(archive).size);
      const entry = parsed.entries.find((e) => e.archivePath === "big.txt");
      expect(entry?.method).toBe(8); // guard the assumption: this is the deflate path

      let calls = 0;
      const sink = async (): Promise<void> => {
        calls++;
        throw new AbortError();
      };
      await expect(readEntryData(file, entry!, sink, chunkSize)).rejects.toBeInstanceOf(AbortError);
      expect(calls).toBeLessThan(8); // tore down at the aborting chunk, not 256

      // The archive handle is shared across concurrent entries: the teardown
      // must stop the source without closing it, or a sibling entry's read
      // would fail. A further stat proves the handle is still open.
      await expect(file.stat()).resolves.toBeDefined();
    } finally {
      await file.close();
    }
  });
});
