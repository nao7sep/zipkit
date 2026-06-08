/**
 * SDK integration over a real temporary tree. Exercises output
 * resolution, the scan → plan → write path, junk exclusion, the metadata file
 * and its no-absolute-paths guarantee, the plan/inspect/write flow, the
 * overwrite gate, deterministic output, and content round-trip.
 */

import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PolicyError, WriteError, ZipKit } from "../../src/index.js";
import { readZip } from "../helpers/readZip.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zipkit-sdk-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeTree(): Promise<string> {
  const proj = path.join(dir, "proj");
  await mkdir(path.join(proj, "sub"), { recursive: true });
  await writeFile(path.join(proj, "a.txt"), "hello hello hello hello");
  await writeFile(path.join(proj, "sub", "b.bin"), Buffer.from([1, 2, 3, 4]));
  await writeFile(path.join(proj, ".DS_Store"), "junk");
  return proj;
}

describe("output resolution and round-trip", () => {
  it("writes <dirname>.zip beside a single directory and flattens its contents", async () => {
    const proj = await makeTree();
    const result = await new ZipKit().create({ inputs: [proj] });

    expect(result.output).toBe(path.join(dir, "proj.zip"));
    expect(existsSync(result.output)).toBe(true);

    const { entries } = readZip(await readFile(result.output));
    const names = entries.map((e) => e.name).sort();
    // Metadata is embedded by default, so it rides along with the flattened content.
    expect(names).toEqual(["_metadata.json", "a.txt", "sub/b.bin"]);
    expect(entries.find((e) => e.name === "a.txt")?.content.toString()).toBe(
      "hello hello hello hello",
    );
  });

  it("excludes junk by default", async () => {
    const proj = await makeTree();
    const result = await new ZipKit().create({ inputs: [proj] });
    const { entries } = readZip(await readFile(result.output));
    expect(entries.find((e) => e.name === ".DS_Store")).toBeUndefined();
    expect(result.summary.excluded).toBeGreaterThanOrEqual(1);
  });

  it("excludes the output itself but keeps real neighbours that share its prefix", async () => {
    const proj = await makeTree();
    const output = path.join(proj, "archive.zip");
    // Files that merely share the output's prefix are real and must be archived,
    // even a numeric suffix that resembles a write-file-atomic temp: zipkit never
    // guesses a file is a temp from its name.
    await writeFile(path.join(proj, "archive.zip.20240604"), "a dated backup");
    await writeFile(path.join(proj, "archive.zip.notes"), "release notes");
    await new ZipKit().create({ inputs: [proj], output, overwrite: true });
    // Second run re-scans the tree, which now contains the output itself.
    await new ZipKit().create({ inputs: [proj], output, overwrite: true });

    const names = readZip(await readFile(output)).entries.map((e) => e.name);
    expect(names).not.toContain("archive.zip"); // excluded by identity
    expect(names).toContain("archive.zip.20240604");
    expect(names).toContain("archive.zip.notes");
  });
});

describe("metadata", () => {
  it("emits a metadata entry with relative paths, CRC, and SHA-256, and no absolute paths", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "meta.zip");
    await new ZipKit().create({
      inputs: [proj],
      output,
      policy: { metadata: { name: "_metadata.json", hash: true } },
    });

    const { entries } = readZip(await readFile(output));
    const meta = entries.find((e) => e.name === "_metadata.json");
    expect(meta).toBeDefined();

    const doc = JSON.parse(meta!.content.toString("utf8"));
    expect(doc.tool).toBe("zipkit");
    expect(Array.isArray(doc.entries)).toBe(true);
    const fileEntry = doc.entries.find((e: { archivePath: string }) => e.archivePath === "a.txt");
    expect(fileEntry.crc32).toBeTypeOf("number");
    expect(fileEntry.sha256).toBeTypeOf("string");
    expect(fileEntry.archivePath).toBe("a.txt");

    // No absolute source path leaks anywhere in the serialized metadata.
    expect(meta!.content.toString("utf8")).not.toContain(dir);
  });

  it("reports the oldest and newest file mtimes as UTC in timeRange", async () => {
    const proj = path.join(dir, "times");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "old.txt"), "older");
    await writeFile(path.join(proj, "new.txt"), "newer");
    // Distinct, known modification times (whole seconds since the epoch).
    const oldSec = Date.parse("2001-02-03T04:05:06Z") / 1000;
    const newSec = Date.parse("2021-12-31T23:59:58Z") / 1000;
    await utimes(path.join(proj, "old.txt"), oldSec, oldSec);
    await utimes(path.join(proj, "new.txt"), newSec, newSec);

    const result = await new ZipKit().create({
      inputs: [proj],
      output: path.join(dir, "times.zip"),
      policy: { metadata: false },
    });

    const range = result.metadata!.timeRange!;
    expect(range.oldest.archivePath).toBe("old.txt");
    expect(range.newest.archivePath).toBe("new.txt");
    expect(range.oldest.mtime.iso).toBe("2001-02-03T04:05:06.000Z");
    expect(range.newest.mtime.iso).toBe("2021-12-31T23:59:58.000Z");
  });

  it("embeds metadata by default and returns the complete record", async () => {
    const proj = await makeTree();
    const result = await new ZipKit().create({ inputs: [proj], output: path.join(dir, "d.zip") });

    // Embedded by default.
    const names = readZip(await readFile(result.output)).entries.map((e) => e.name);
    expect(names).toContain("_metadata.json");

    // The full structured record is returned regardless.
    expect(result.metadata.tool).toBe("zipkit");
    expect(result.metadata.timeZone).toBeTypeOf("string");
    expect(Array.isArray(result.metadata.findings)).toBe(true);
    const a = result.metadata.entries.find((e) => e.archivePath === "a.txt");
    expect(a?.sha256).toBeTypeOf("string"); // hashing on by default
    expect(a?.mtime.ns).toBeTypeOf("string"); // times always present in the return
  });

  it("produces a plain archive under metadata:false but still returns the record", async () => {
    const proj = await makeTree();
    const result = await new ZipKit().create({
      inputs: [proj],
      output: path.join(dir, "plain.zip"),
      policy: { metadata: false },
    });

    // No metadata entry in the archive.
    const names = readZip(await readFile(result.output)).entries.map((e) => e.name);
    expect(names).not.toContain("_metadata.json");
    expect(names.sort()).toEqual(["a.txt", "sub/b.bin"]);

    // The record is still returned (the run's state), with times but no SHA
    // (hashing wasn't requested), so a caller can still inspect the run.
    expect(result.metadata.entries.find((e) => e.archivePath === "a.txt")?.mtime.ns).toBeTypeOf(
      "string",
    );
    expect(result.metadata.entries.find((e) => e.archivePath === "a.txt")?.sha256).toBeUndefined();
  });

  it("records a SHA-256 that matches the file content", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "hash.zip");
    await new ZipKit().create({
      inputs: [proj],
      output,
      policy: { metadata: { name: "_metadata.json", hash: true } },
    });

    const { entries } = readZip(await readFile(output));
    const doc = JSON.parse(entries.find((e) => e.name === "_metadata.json")!.content.toString("utf8"));
    const fileEntry = doc.entries.find((e: { archivePath: string }) => e.archivePath === "a.txt");
    const expected = createHash("sha256").update("hello hello hello hello").digest("hex");
    expect(fileEntry.sha256).toBe(expected);
  });
});

describe("plan / inspect / write flow", () => {
  it("plans without writing, then writes the inspected plan", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "flow.zip");
    const zip = new ZipKit();

    const plan = await zip.plan({ inputs: [proj], output });
    expect(existsSync(output)).toBe(false); // plan writes nothing
    expect(plan.writable).toBe(true);

    const result = await zip.write(plan);
    expect(result.mode).toBe("write");
    expect(result.written).toBe(true);
    expect(existsSync(output)).toBe(true);
    const { entries } = readZip(await readFile(output));
    // The metadata document lists every written entry except the embedded
    // _metadata.json itself, which rides as the archive's final entry.
    expect((result.metadata?.entries.length ?? 0) + 1).toBe(entries.length);
  });
});

describe("options validation", () => {
  it("rejects a non-positive or fractional concurrency at construction (the SDK owns the bound)", () => {
    expect(() => new ZipKit({ concurrency: 0 })).toThrow(PolicyError);
    expect(() => new ZipKit({ concurrency: -2 })).toThrow(PolicyError);
    expect(() => new ZipKit({ concurrency: 1.5 })).toThrow(PolicyError);
  });

  it("rejects a non-positive chunkSize at construction", () => {
    expect(() => new ZipKit({ chunkSize: 0 })).toThrow(PolicyError);
  });

  it("accepts a valid concurrency", () => {
    expect(() => new ZipKit({ concurrency: 8 })).not.toThrow();
  });
});

describe("overwrite gate", () => {
  it("refuses to write over an existing output without overwrite", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "gate.zip");
    await new ZipKit().create({ inputs: [proj], output });

    await expect(new ZipKit().create({ inputs: [proj], output })).rejects.toBeInstanceOf(WriteError);
    await expect(
      new ZipKit().create({ inputs: [proj], output, overwrite: true }),
    ).resolves.toMatchObject({ output });
  });
});

