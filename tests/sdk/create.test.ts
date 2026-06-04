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

describe("sidecar safety", () => {
  it("refuses to overwrite an existing sidecar without overwrite, even when the archive is new", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "side.zip"); // does not exist yet
    const sidecar = path.join(dir, "pre.json");
    await writeFile(sidecar, "do not clobber me");

    const policy = { metadata: { name: "pre.json", placement: "sidecar" as const, hash: false } };
    await expect(new ZipKit().create({ inputs: [proj], output, policy })).rejects.toBeInstanceOf(
      WriteError,
    );
    // The sidecar is untouched by the refused run.
    expect(await readFile(sidecar, "utf8")).toBe("do not clobber me");

    // Authorizing overwrite lets both files be written.
    await new ZipKit().create({ inputs: [proj], output, overwrite: true, policy });
    expect(JSON.parse(await readFile(sidecar, "utf8")).tool).toBe("zipkit");
  });

  it("never archives a stale sidecar that lives inside the input tree", async () => {
    const proj = await makeTree();
    const output = path.join(proj, "a.zip"); // output (and sidecar) inside the input
    await writeFile(path.join(proj, "meta.json"), "stale sidecar");

    await new ZipKit().create({
      inputs: [proj],
      output,
      overwrite: true,
      policy: { metadata: { name: "meta.json", placement: "sidecar", hash: false } },
    });

    const names = readZip(await readFile(output)).entries.map((e) => e.name);
    expect(names).not.toContain("meta.json");
  });

  it("never archives a differently-cased sidecar that aliases to the same file", async () => {
    const proj = await makeTree();
    const output = path.join(proj, "a.zip"); // output (and sidecar) inside the input
    await writeFile(path.join(proj, "meta.json"), "stale sidecar");
    // On a case-insensitive filesystem `Meta.json` and `meta.json` name one file;
    // the configured sidecar therefore aliases the stale one. Detect the volume's
    // behaviour so the assertion holds on both: exclusion is by file identity, so
    // the file is dropped exactly when the two names are truly the same file.
    const caseInsensitive = existsSync(path.join(proj, "Meta.json"));

    await new ZipKit().create({
      inputs: [proj],
      output,
      overwrite: true,
      policy: { metadata: { name: "Meta.json", placement: "sidecar", hash: false } },
    });

    const names = readZip(await readFile(output)).entries.map((e) => e.name);
    if (caseInsensitive) {
      expect(names).not.toContain("meta.json"); // the sidecar under a different case
    } else {
      expect(names).toContain("meta.json"); // a genuinely distinct neighbour
    }
  });

  it("rejects a sidecar name that resolves to the output archive", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "clash.json");
    await expect(
      new ZipKit().create({
        inputs: [proj],
        output,
        policy: { metadata: { name: "clash.json", placement: "sidecar", hash: false } },
      }),
    ).rejects.toBeInstanceOf(PolicyError);
  });

  it("rejects a sidecar name that collides with the output by case only", async () => {
    const proj = await makeTree();
    // On the default case-insensitive macOS/Windows filesystems these name the
    // same file, so the sidecar would otherwise overwrite the archive.
    const output = path.join(dir, "Clash.JSON");
    await expect(
      new ZipKit().create({
        inputs: [proj],
        output,
        policy: { metadata: { name: "clash.json", placement: "sidecar", hash: false } },
      }),
    ).rejects.toBeInstanceOf(PolicyError);
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
