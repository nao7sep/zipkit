/**
 * SDK integration over a real temporary tree. Exercises output
 * resolution, the scan → plan → write path, junk exclusion, the metadata file
 * and its no-absolute-paths guarantee, the plan/inspect/write flow, the
 * overwrite gate, deterministic output, and content round-trip.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WriteError, ZipKit } from "../../src/index.js";
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
    expect(names).toEqual(["a.txt", "sub/b.bin"]);
    expect(entries.find((e) => e.name === "a.txt")?.content.toString()).toBe(
      "hello hello hello hello",
    );
  });

  it("excludes junk by default", async () => {
    const proj = await makeTree();
    const result = await new ZipKit().create({ inputs: [proj] });
    const { entries } = readZip(await readFile(result.output));
    expect(entries.find((e) => e.name === ".DS_Store")).toBeUndefined();
    expect(result.excluded).toBeGreaterThanOrEqual(1);
  });

  it("excludes the output and its atomic-write temp artifacts when written inside an input", async () => {
    const proj = await makeTree();
    const output = path.join(proj, "archive.zip");
    // A stale temp matching write-file-atomic's `<output>.<suffix>` pattern.
    await writeFile(path.join(proj, "archive.zip.stale123"), "stale temp");
    await new ZipKit().create({ inputs: [proj], output, overwrite: true });
    // Second run re-scans the tree, which now contains the output itself.
    await new ZipKit().create({ inputs: [proj], output, overwrite: true });

    const names = readZip(await readFile(output)).entries.map((e) => e.name);
    expect(names).not.toContain("archive.zip");
    expect(names.some((n) => n.startsWith("archive.zip."))).toBe(false);
  });
});

describe("metadata", () => {
  it("emits a metadata entry with relative paths, CRC, and SHA-256, and no absolute paths", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "meta.zip");
    await new ZipKit().create({
      inputs: [proj],
      output,
      policy: { metadata: { name: "_metadata.json", placement: "inside", hash: true } },
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

  it("keeps the container-level Zip64 finding free of absolute paths", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "z64.zip");
    await new ZipKit().create({
      inputs: [proj],
      output,
      policy: { zip64: "always", metadata: { name: "_metadata.json", placement: "inside", hash: false } },
    });

    const { entries } = readZip(await readFile(output));
    const meta = entries.find((e) => e.name === "_metadata.json")!;
    const text = meta.content.toString("utf8");
    expect(text).not.toContain(dir);

    const doc = JSON.parse(text);
    const zfinding = doc.findings.find((f: { rule: string }) => f.rule === "compat.zip64");
    expect(zfinding.path).toBe("z64.zip");
  });

  it("writes metadata as a sidecar beside the archive under placement 'sidecar'", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "side.zip");
    await new ZipKit().create({
      inputs: [proj],
      output,
      policy: { metadata: { name: "side.json", placement: "sidecar", hash: false } },
    });

    // The metadata is not an entry inside the archive...
    const { entries } = readZip(await readFile(output));
    expect(entries.find((e) => e.name === "side.json")).toBeUndefined();

    // ...it lives next to the archive instead.
    const sidecar = path.join(dir, "side.json");
    expect(existsSync(sidecar)).toBe(true);
    const doc = JSON.parse(await readFile(sidecar, "utf8"));
    expect(doc.tool).toBe("zipkit");
    expect(doc.entries.some((e: { archivePath: string }) => e.archivePath === "a.txt")).toBe(true);
  });

  it("records a SHA-256 that matches the file content", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "hash.zip");
    await new ZipKit().create({
      inputs: [proj],
      output,
      policy: { metadata: { name: "_metadata.json", placement: "inside", hash: true } },
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
    expect(existsSync(output)).toBe(true);
    const { entries } = readZip(await readFile(output));
    expect(result.entries).toBe(entries.length);
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

describe("deterministic output", () => {
  it("produces byte-identical archives across runs", async () => {
    const proj = await makeTree();
    const a = path.join(dir, "a.zip");
    const b = path.join(dir, "b.zip");
    const zip = new ZipKit({ policy: { deterministic: true } });
    await zip.create({ inputs: [proj], output: a });
    await zip.create({ inputs: [proj], output: b });
    expect((await readFile(a)).equals(await readFile(b))).toBe(true);
  });
});
