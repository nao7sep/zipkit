/**
 * The write edge's source check: a source file must still be what the scan
 * recorded when the writer reads it. A changed size or modification time, or
 * more bytes than were scanned, fails the whole write with
 * `write.source-changed` naming the file, and no archive or temp file is left.
 * The plan's visible fields must agree with its instructions, a source gone
 * since the plan fails by cause, and an output that appeared since the plan
 * is a refusal, on a file system with hard links or without.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipKit, ZipKitError, type PlanData } from "../../src/index.ts";
import { nodeFileSystem, Volume } from "../../src/internal/volume.ts";
import { createLogger } from "../../src/log/logger.ts";
import { writeArchive } from "../../src/write/write.ts";
import { fileSystemWith } from "../helpers/volume.ts";

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
    volume: volume ?? new Volume(fileSystemWith("", (h) => h)),
  });
}

async function expectSourceChanged(run: Promise<unknown>): Promise<void> {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ZipKitError);
  expect(err).toMatchObject({ code: "write.source-changed", subject: source });
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
    await expectSourceChanged(write(plan, new Volume(port)));
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
    await expectSourceChanged(write(plan, new Volume(port)));
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
    expect(result).toMatchObject({ mode: "write" });
    expect(existsSync(output)).toBe(true);
  });
});

describe("a plan whose visible fields disagree with its instructions", () => {
  it.each([
    ["a relative output", (p: PlanData) => ({ ...p, output: "out.zip" })],
    ["another output", (p: PlanData) => ({ ...p, output: path.join(dir, "elsewhere.zip") })],
    ["writable set by hand", (p: PlanData) => ({ ...p, writable: true })],
    ["the Zip64 verdict flipped", (p: PlanData) => ({ ...p, summary: { ...p.summary, zip64: !p.summary.zip64 } })],
  ])("is refused as plan.invalid: %s", async (_name, edit) => {
    await writeFile(output, "already here");
    const plan = await new ZipKit().plan({ inputs: [proj], output });
    expect(plan.writable).toBe(false);
    const edited = edit(plan);
    // Writable by hand only matters on a blocked plan; the others start writable.
    const given = edited.writable === plan.writable ? edit({ ...plan, writable: true, instructions: { ...plan.instructions, writable: true } }) : edited;
    await expect(write(given)).rejects.toMatchObject({ code: "plan.invalid", kind: "invalid" });
    expect(readFileSync(output, "utf8")).toBe("already here");
    expect(existsSync(path.join(process.cwd(), "out.zip"))).toBe(false);
  });

  it("is refused as write.not-writable, naming the output, when the instructions block it", async () => {
    await writeFile(output, "already here");
    const plan = await new ZipKit().plan({ inputs: [proj], output });
    await expect(write(plan)).rejects.toMatchObject({ code: "write.not-writable", subject: output });
  });
});

describe("a missing output folder", () => {
  it("is made, with its parents, when the archive is written, and not by planning", async () => {
    const nested = path.join(dir, "new", "deeper");
    const zip = new ZipKit();
    const plan = await zip.plan({ inputs: [proj], outputDir: nested, outputName: "out" });
    expect(plan.writable).toBe(true);
    expect(existsSync(path.join(dir, "new"))).toBe(false);
    expect(await zip.write(plan)).toMatchObject({ mode: "write", output: path.join(nested, "out.zip") });
    expect((await zip.verify({ archive: path.join(nested, "out.zip"), manifest: true })).ok).toBe(true);
  });

  it("fails by cause when a file has taken the folder's place since the plan", async () => {
    const folder = path.join(dir, "later", "inside");
    const zip = new ZipKit();
    const plan = await zip.plan({ inputs: [proj], outputDir: folder, outputName: "out" });
    await writeFile(path.join(dir, "later"), "a file");
    await expect(zip.write(plan)).rejects.toMatchObject({ kind: "unavailable" });
    expect(readdirSync(dir).sort()).toEqual(["later", "proj"]);
  });
});

describe("a source gone since the plan", () => {
  it("fails as path.missing naming the file, not the archive", async () => {
    const plan = await new ZipKit().plan({ inputs: [proj], output });
    await unlink(source);
    await expect(write(plan)).rejects.toMatchObject({ code: "path.missing", kind: "unavailable", subject: source });
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(dir)).toEqual(["proj"]);
  });
});

/** A file system without hard links, as exFAT and FAT are. */
const noHardLinks = { ...nodeFileSystem, link: async (): Promise<never> => { throw Object.assign(new Error("not supported"), { code: "ENOTSUP" }); } };

describe.each([
  ["with hard links", nodeFileSystem],
  ["without hard links", noHardLinks],
])("an output that appeared since the plan, %s", (_name, port) => {
  it("is a refusal like a plan that blocks, and the other file is kept", async () => {
    const plan = await new ZipKit().plan({ inputs: [proj], output });
    await writeFile(output, "someone else's");
    const result = await write(plan, new Volume(port));
    expect(result).toMatchObject({ mode: "plan", output, writable: false, instructions: { writable: false } });
    expect((result as PlanData).findings.at(-1)).toMatchObject({ rule: "output.exists", severity: "error", path: output });
    expect(result.summary.errors).toBe(plan.summary.errors + 1);
    expect(readFileSync(output, "utf8")).toBe("someone else's");
    expect(readdirSync(dir).sort()).toEqual(["out.zip", "proj"]);
  });

  it("is not in the way when the name is free: the archive is published whole", async () => {
    const plan = await new ZipKit().plan({ inputs: [proj], output });
    expect(await write(plan, new Volume(port))).toMatchObject({ mode: "write", output });
    expect(readdirSync(dir).sort()).toEqual(["out.zip", "proj"]);
    expect((await new ZipKit().verify({ archive: output, manifest: true })).ok).toBe(true);
  });
});
