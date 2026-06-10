/**
 * Abort propagation through the SDK. The CLI-level test covers SIGINT signal
 * isolation; this covers the signal actually flowing through the scan → write
 * pipeline: an already-aborted signal stops plan() at the scan edge, and an
 * abort raised mid-write rejects with AbortError and leaves no output behind.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, openSync, closeSync, statSync, fstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AbortError, ZipKit } from "../../src/index.js";
import { ZipWriter } from "../../src/write/zipWriter.js";
import { parseZip, readEntryData } from "../../src/extract/zipReader.js";

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
    // A large incompressible entry streams over many chunks. The abort is raised
    // the instant the entry's staging temp file appears — by then the per-entry
    // pre-walk check has already passed and the inflate loop is running, so the
    // cancellation lands on the per-chunk sink boundary (not the entry boundary)
    // and no file may be committed.
    const big = path.join(dir, "big.bin");
    await writeFile(big, randomBytes(16 * 1024 * 1024));
    const archive = path.join(dir, "big.zip");
    const zip = new ZipKit();
    await zip.create({ inputs: [big], output: archive });

    const dest = path.join(dir, "out");
    await mkdir(dest, { recursive: true });
    const controller = new AbortController();
    const watcher = setInterval(() => {
      let staged = false;
      try {
        staged = readdirSync(dest).some((n) => n.startsWith(".zk-"));
      } catch {
        /* dest not yet created */
      }
      if (staged) {
        clearInterval(watcher);
        controller.abort();
      }
    }, 0);

    try {
      await expect(
        zip.extract({ archive, dest }, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(AbortError);
    } finally {
      clearInterval(watcher);
    }
    expect(existsSync(path.join(dest, "big.bin"))).toBe(false);
  });
});

describe("abort boundaries (unit)", () => {
  it("finalize() stops before the rename when aborted, leaving no archive", async () => {
    // The create() publish boundary: even after the entries stream, a Ctrl-C
    // during the central-directory write / fsync must not rename the temp file
    // into place. There is no progress event in this window, so the guarantee is
    // pinned at the writer seam with an already-aborted signal.
    const output = path.join(dir, "finalize-abort.zip");
    const writer = new ZipWriter(output, {
      timeZone: "UTC",
      chunkSize: 65536,
    });
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
    // 16 MiB of compressible bytes → one deflated (method 8) entry that inflates
    // to ~256 output chunks. A sink that throws on its first chunk must tear the
    // inflate pipeline down there, not drain the whole entry — so the sink is
    // called a handful of times, not ~256.
    const big = path.join(dir, "big.txt");
    await writeFile(big, Buffer.alloc(16 * 1024 * 1024, 0x61));
    const archive = path.join(dir, "deflated.zip");
    await new ZipKit().create({ inputs: [big], output: archive });

    const fd = openSync(archive, "r");
    try {
      const parsed = await parseZip(fd, statSync(archive).size);
      const entry = parsed.entries.find((e) => e.archivePath.endsWith("big.txt"));
      expect(entry?.method).toBe(8); // guard the assumption: this is the deflate path

      let calls = 0;
      const sink = async (): Promise<void> => {
        calls++;
        throw new AbortError();
      };
      await expect(readEntryData(fd, entry!, sink, 65536)).rejects.toBeInstanceOf(AbortError);
      expect(calls).toBeLessThan(8); // tore down at the aborting chunk, not ~256

      // The archive fd is shared across concurrent entries: the teardown must
      // stop the source without closing it, or a sibling entry's read would
      // EBADF. fstat proves the fd is still open.
      expect(() => fstatSync(fd)).not.toThrow();
    } finally {
      closeSync(fd);
    }
  });
});
