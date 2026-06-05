/**
 * Abort propagation through the SDK. The CLI-level test covers SIGINT signal
 * isolation; this covers the signal actually flowing through the scan → write
 * pipeline: an already-aborted signal stops plan() at the scan edge, and an
 * abort raised mid-write rejects with AbortError and leaves no output behind.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AbortError, ZipKit } from "../../src/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zipkit-abort-"));
});

afterEach(async () => {
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
      new ZipKit().plan({ inputs: [proj], signal: controller.signal }),
    ).rejects.toBeInstanceOf(AbortError);
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
        { inputs: [proj], output, signal: controller.signal },
        {
          onProgress: (event) => {
            if (event.message === "write.start") controller.abort();
          },
        },
      ),
    ).rejects.toBeInstanceOf(AbortError);
    expect(existsSync(output)).toBe(false);
  });
});
