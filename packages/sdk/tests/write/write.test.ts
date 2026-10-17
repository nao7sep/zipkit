/**
 * The write edge's source check: a source file must still be what the scan
 * recorded when the writer reads it. A changed size or modification time, or
 * more bytes than were scanned, fails the whole write with
 * `write.source-changed` naming the entry, and no archive or temp file is left.
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WriteError, ZipKit } from "../../../src/sdk/index.js";
import { Volume } from "../../../src/sdk/internal/volume.js";
import { createLogger } from "../../../src/sdk/log/logger.js";
import { writeArchive } from "../../../src/sdk/write/write.js";
import { fileSystemWith } from "../../helpers/volume.js";

let dir: string;
let proj: string;
let source: string;
let output: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zipkit-write-"));
  proj = path.join(dir, "proj");
  await mkdir(proj);
  source = path.join(proj, "data.txt");
  await writeFile(source, "scanned content");
  await writeFile(path.join(proj, "other.txt"), "untouched");
  output = path.join(dir, "out.zip");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function write(plan: Awaited<ReturnType<ZipKit["plan"]>>, volume?: Volume) {
  return writeArchive(plan, {
    logger: createLogger(),
    chunkSize: 64,
    volume: volume ?? new Volume(fileSystemWith("", (h) => h), 30_000),
  });
}

async function expectSourceChanged(run: Promise<unknown>): Promise<void> {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WriteError);
  expect(err).toMatchObject({ code: "write.source-changed", path: "data.txt" });
  expect(existsSync(output)).toBe(false);
  expect(readdirSync(dir)).toEqual(["proj"]); // no temp left behind
}

describe("a source file changed during Create", () => {
  it("fails when the open file reports another modification time", async () => {
    const plan = await new ZipKit().plan({ inputs: [proj], output });
    const port = fileSystemWith(source, (handle) => ({
      ...handle,
      stat: async () => {
        const st = await handle.stat();
        st.mtimeNs += 1_000_000_000n;
        return st;
      },
    }));
    await expectSourceChanged(write(plan, new Volume(port, 30_000)));
  });

  it("fails when the file returns more bytes than were scanned", async () => {
    const plan = await new ZipKit().plan({ inputs: [proj], output });
    const port = fileSystemWith(source, (handle) => ({
      ...handle,
      // The file keeps growing: every read past the scanned end still returns data.
      read: async (buffer, offset, length, position) => {
        const got = await handle.read(buffer, offset, length, position);
        if (got.bytesRead > 0) return got;
        buffer.fill(0x41, offset, offset + length);
        return { bytesRead: length, buffer };
      },
    }));
    await expectSourceChanged(write(plan, new Volume(port, 30_000)));
  });

  it("fails when the file was edited on disk after the scan", async () => {
    const plan = await new ZipKit().plan({ inputs: [proj], output });
    await writeFile(source, "edited content!");
    await utimes(source, new Date(2001, 0, 1), new Date(2001, 0, 1));
    await expectSourceChanged(write(plan));
  });

  it("writes the archive when nothing changed", async () => {
    const plan = await new ZipKit().plan({ inputs: [proj], output });
    const result = await write(plan);
    expect(result.written).toBe(true);
    expect(existsSync(output)).toBe(true);
  });
});
