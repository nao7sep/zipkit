/**
 * SDK integration over a real temporary tree. Exercises output
 * resolution, the scan → plan → write path, junk exclusion, the metadata file
 * and its no-absolute-paths guarantee, the plan/inspect/write flow, the
 * overwrite gate, deterministic output, and content round-trip.
 */

import { chmod, link, mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipKit, ZipKitError } from "../src/index.ts";
import { readZip } from "./helpers/readZip.ts";
import { createFileLink, fileSymlinksSupported } from "./helpers/symlink.ts";
import { invalidError } from "./helpers/errors.ts";
import { written } from "./helpers/written.ts";

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
    // Manifest is embedded by default, so it rides along with the flattened content.
    expect(names).toEqual(["a.txt", "sub/", "sub/b.bin", "zipkit.json"]);
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

// POSIX permissions; Windows keeps only a read-only flag, which a replace cannot write through.
it.skipIf(process.platform === "win32")("keeps an existing archive's permission mode when overwriting it", async () => {
  const proj = await makeTree();
  const output = path.join(dir, "out.zip");
  await new ZipKit().create({ inputs: [proj], output });
  await chmod(output, 0o600);
  await writeFile(path.join(proj, "a.txt"), "changed");

  await new ZipKit().create({ inputs: [proj], output, overwrite: true });

  expect(readZip(await readFile(output)).entries.find((e) => e.name === "a.txt")?.content.toString()).toBe("changed");
  expect((await stat(output)).mode & 0o777).toBe(0o600);
});

describe("metadata", () => {
  it("emits a metadata entry with relative paths, CRC, and SHA-256, and no absolute paths", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "meta.zip");
    await new ZipKit().create({
      inputs: [proj],
      output,
      policy: { manifest: { name: "zipkit.json", hash: true } },
    });

    const { entries } = readZip(await readFile(output));
    const meta = entries.find((e) => e.name === "zipkit.json");
    expect(meta).toBeDefined();

    const doc = JSON.parse(meta!.content.toString("utf8"));
    expect(doc.app).toBe("ZipKit");
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
      policy: { manifest: false },
    });

    const range = written(result).manifest.timeRange!;
    expect(range.oldest.archivePath).toBe("old.txt");
    expect(range.newest.archivePath).toBe("new.txt");
    expect(range.oldest.mtime.iso).toBe("2001-02-03T04:05:06.000Z");
    expect(range.newest.mtime.iso).toBe("2021-12-31T23:59:58.000Z");
  });

  it("warns about a DOS-range clamp exactly when the writer clamps, in the writer's zone", async (ctx) => {
    const proj = path.join(dir, "edge");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "late.txt"), "late");
    // 2107-12-31T23:00:00Z: in range in UTC and Los Angeles, 2108 in Tokyo.
    const sec = Date.UTC(2107, 11, 31, 23) / 1000;
    await utimes(path.join(proj, "late.txt"), sec, sec);
    // The case needs a file time past 2106. Where the file system or runtime
    // cannot hold one, the input this test describes cannot be made.
    if ((await stat(path.join(proj, "late.txt"))).mtimeMs !== sec * 1000) ctx.skip();
    const dosMaxDate = ((2107 - 1980) << 9) | (12 << 5) | 31;
    const dosMaxTime = (23 << 11) | (59 << 5) | 29;

    const tokyo = await new ZipKit().create({
      inputs: [proj],
      output: path.join(dir, "tokyo.zip"),
      policy: { timeZone: "Asia/Tokyo", manifest: false },
    });
    expect(tokyo.findings.map((f) => f.rule)).toContain("time.post-2107");
    expect(written(tokyo).manifest.timeZone).toBe("Asia/Tokyo");
    const clamped = readZip(await readFile(tokyo.output)).entries[0]!;
    expect([clamped.dosDate, clamped.dosTime]).toEqual([dosMaxDate, dosMaxTime]);

    const la = await new ZipKit().create({
      inputs: [proj],
      output: path.join(dir, "la.zip"),
      policy: { timeZone: "America/Los_Angeles", manifest: false },
    });
    expect(la.findings.map((f) => f.rule)).not.toContain("time.post-2107");
    const kept = readZip(await readFile(la.output)).entries[0]!;
    expect(kept.dosDate).toBe(dosMaxDate); // 2107-12-31, local 15:00
    expect(kept.dosTime).toBe(15 << 11);
  });

  it("embeds metadata by default and returns the complete record", async () => {
    const proj = await makeTree();
    const result = await new ZipKit().create({ inputs: [proj], output: path.join(dir, "d.zip") });

    // Embedded by default.
    const names = readZip(await readFile(result.output)).entries.map((e) => e.name);
    expect(names).toContain("zipkit.json");

    // The full structured record is returned regardless.
    expect(written(result).manifest.app).toBe("ZipKit");
    expect(written(result).manifest.timeZone).toBeTypeOf("string");
    expect(Array.isArray(written(result).manifest.findings)).toBe(true);
    const a = written(result).manifest.entries.find((e) => e.archivePath === "a.txt");
    expect(a?.sha256).toBeTypeOf("string"); // hashing on by default
    expect(a?.mtime.ns).toBeTypeOf("string"); // times always present in the return
  });

  it("returns the same summary the manifest embeds; the exact zip64 is the top-level field", async () => {
    const proj = await makeTree();
    const result = await new ZipKit().create({ inputs: [proj], output: path.join(dir, "s.zip") });

    // The returned summary is the very object embedded in the manifest, so
    // `summary.zip64` (the plan's pre-write estimate) can never diverge between
    // the two — guards against forking it back into a separate object.
    expect(result.summary).toBe(written(result).manifest.summary);
    // The exact post-write Zip64 outcome is the top-level field on the result.
    expect(written(result).zip64).toBeTypeOf("boolean");
  });

  it("produces a plain archive under manifest:false but still returns the record", async () => {
    const proj = await makeTree();
    const result = await new ZipKit().create({
      inputs: [proj],
      output: path.join(dir, "plain.zip"),
      policy: { manifest: false },
    });

    // No metadata entry in the archive.
    const names = readZip(await readFile(result.output)).entries.map((e) => e.name);
    expect(names).not.toContain("zipkit.json");
    expect(names.sort()).toEqual(["a.txt", "sub/", "sub/b.bin"]);

    // The record is still returned (the run's state), with times but no SHA
    // (hashing wasn't requested), so a caller can still inspect the run.
    expect(written(result).manifest.entries.find((e) => e.archivePath === "a.txt")?.mtime.ns).toBeTypeOf(
      "string",
    );
    expect(written(result).manifest.entries.find((e) => e.archivePath === "a.txt")?.sha256).toBeUndefined();
  });

  it("records a SHA-256 that matches the file content", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "hash.zip");
    await new ZipKit().create({
      inputs: [proj],
      output,
      policy: { manifest: { name: "zipkit.json", hash: true } },
    });

    const { entries } = readZip(await readFile(output));
    const doc = JSON.parse(entries.find((e) => e.name === "zipkit.json")!.content.toString("utf8"));
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
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(output)).toBe(true);
    const { entries } = readZip(await readFile(output));
    // The metadata document lists every written entry except the embedded
    // zipkit.json itself, which rides as the archive's final entry.
    expect((result.manifest?.entries.length ?? 0) + 1).toBe(entries.length);
  });
});

describe("options validation", () => {
  it("rejects a non-positive or fractional concurrency at construction (the SDK owns the bound)", () => {
    expect(() => new ZipKit({ concurrency: 0 })).toThrow(invalidError);
    expect(() => new ZipKit({ concurrency: -2 })).toThrow(invalidError);
    expect(() => new ZipKit({ concurrency: 1.5 })).toThrow(invalidError);
  });

  it("rejects a non-positive chunkSize at construction", () => {
    expect(() => new ZipKit({ chunkSize: 0 })).toThrow(invalidError);
  });

  it("accepts a valid concurrency", () => {
    expect(() => new ZipKit({ concurrency: 8 })).not.toThrow();
  });
});

describe("overwrite gate", () => {
  it("returns the blocked plan, unwritten, for an existing output without overwrite", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "gate.zip");
    await new ZipKit().create({ inputs: [proj], output });
    const before = await readFile(output);

    const refused = await new ZipKit().create({ inputs: [proj], output });
    expect(refused).toMatchObject({ mode: "plan", writable: false });
    expect(refused.findings.map((f) => f.rule)).toContain("output.exists");
    expect((await readFile(output)).equals(before)).toBe(true);
    await expect(
      new ZipKit().create({ inputs: [proj], output, overwrite: true }),
    ).resolves.toMatchObject({ output });
  });

  it("preserves an output created after planning when overwrite was not authorized", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "late.zip");
    const zip = new ZipKit();
    const plan = await zip.plan({ inputs: [proj], output });
    await writeFile(output, "another process won");

    await expect(zip.write(plan)).rejects.toBeInstanceOf(ZipKitError);
    expect(await readFile(output, "utf8")).toBe("another process won");
  });

  it("rejects an output that is the same physical file as an input", async () => {
    const source = path.join(dir, "source.zip");
    await writeFile(source, "only copy");

    await expect(
      new ZipKit().create({ inputs: [source], output: source, overwrite: true }),
    ).rejects.toMatchObject({ code: "scan.output-is-input" });
    expect(await readFile(source, "utf8")).toBe("only copy");
  });

  it("rejects a hard-link alias of an input as the output", async () => {
    const source = path.join(dir, "source.bin");
    const output = path.join(dir, "alias.zip");
    await writeFile(source, "only copy");
    await link(source, output);
    await expect(
      new ZipKit().create({ inputs: [source], output, overwrite: true }),
    ).rejects.toMatchObject({ code: "scan.output-is-input" });
    expect(await readFile(source, "utf8")).toBe("only copy");
  });
});

describe("symlink preservation and empty directories", () => {
  it.runIf(fileSymlinksSupported)("writes a preserved symlink entry and a kept empty directory through create", async () => {
    const proj = path.join(dir, "tree");
    await mkdir(path.join(proj, "emptydir"), { recursive: true });
    await writeFile(path.join(proj, "real.txt"), "content");
    await createFileLink("real.txt", path.join(proj, "link.txt"));

    const output = path.join(dir, "tree.zip");
    const result = await new ZipKit().create({
      inputs: [proj],
      output,
      policy: { symlinks: "preserve", emptyDirs: "keep" },
    });

    const entries = written(result).manifest.entries;
    const link = entries.find((e) => e.archivePath === "link.txt");
    expect(link?.type).toBe("symlink"); // the writer emitted a Unix link entry
    expect(link?.linkTarget).toBe("real.txt");
    expect(link?.sha256).toBeTypeOf("string"); // hashed over the link-target bytes

    const empty = entries.find((e) => e.archivePath === "emptydir");
    expect(empty?.type).toBe("dir"); // a leaf empty dir gets an explicit entry under keep

    // The produced archive is well-formed and round-trips on read.
    const report = await new ZipKit().verify(output);
    expect(report.ok).toBe(true);
  });
});

// A name POSIX allows and Windows does not cannot be made on Windows.
describe.skipIf(process.platform === "win32")("the archive's own name", () => {
  it("is fixed when inferred from a folder, and reported as the entries' names are", async () => {
    const proj = path.join(dir, "Q1: Plans?");
    await mkdir(proj);
    await writeFile(path.join(proj, "a.txt"), "a");
    const plan = await new ZipKit().plan({ inputs: [proj] });
    expect(plan.output).toBe(path.join(dir, "Q1 Plans.zip"));
    expect(plan.findings).toContainEqual(expect.objectContaining({
      rule: "name.invalid-char", severity: "info", path: path.join(dir, "Q1: Plans?.zip"), fix: { kind: "rename", to: plan.output },
    }));
    expect(plan.writable).toBe(true);
  });

  it("is kept as given, with a warning, and blocks only when the policy says error", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(proj);
    await writeFile(path.join(proj, "a.txt"), "a");
    const given = await new ZipKit().plan({ inputs: [proj], outputName: "CON" });
    expect(given.output).toBe(path.join(dir, "CON.zip"));
    expect(given.findings).toContainEqual(expect.objectContaining({ rule: "name.reserved", severity: "warning" }));
    expect(given.writable).toBe(true);
    const strict = await new ZipKit().plan({ inputs: [proj], outputName: "CON", policy: { names: { reserved: "error" } } });
    expect(strict.writable).toBe(false);
  });
});

describe("Windows' path limit", () => {
  it("counts the folder an archive is extracted into, named after it", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(proj);
    // 200 characters fit 260 alone, but not with a 40-character location and the archive's folder.
    const name = `${"n".repeat(196)}.txt`;
    await writeFile(path.join(proj, name), "a");
    const short = await new ZipKit().plan({ inputs: [proj], outputName: "p" });
    expect(short.findings.map((f) => f.rule)).not.toContain("path.too-long");
    const long = await new ZipKit().plan({ inputs: [proj], outputName: "x".repeat(30) });
    expect(long.findings).toContainEqual(expect.objectContaining({ rule: "path.too-long", severity: "warning", path: name }));
  });
});

describe("unsupported items", () => {
  it.skipIf(process.platform === "win32")("say what they are", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(proj);
    await writeFile(path.join(proj, "a.txt"), "a");
    await symlink(path.join(dir, "nowhere"), path.join(proj, "dangling"));
    const plan = await new ZipKit().plan({ inputs: [proj], policy: { symlinks: "follow" } });
    expect(plan.entries.find((e) => e.archivePath === "dangling")).toMatchObject({ excludeCode: "unsupported", unsupportedKind: "broken-link" });
  });
});

describe("outputDir and outputName", () => {
  it("place and name the archive, and refuse a name that is a path or a spec that also gives output", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(proj);
    await writeFile(path.join(proj, "a.txt"), "a");
    const out = path.join(dir, "out");
    await mkdir(out);
    const plan = await new ZipKit().plan({ inputs: [proj], outputDir: out, outputName: "delivery" });
    expect(plan.output).toBe(path.join(out, "delivery.zip"));
    await expect(new ZipKit().plan({ inputs: [proj], outputDir: out, outputName: "a/b" })).rejects.toThrow(invalidError);
    await expect(new ZipKit().plan({ inputs: [proj], outputName: ".." })).rejects.toThrow(invalidError);
    await expect(new ZipKit().plan({ inputs: [proj], output: path.join(out, "x.zip"), outputDir: out })).rejects.toThrow(invalidError);
  });
});

describe("entry order", () => {
  it("is the same on every run, in path order with each folder before what it holds", async () => {
    const proj = path.join(dir, "ordered");
    for (let i = 0; i < 40; i++) {
      const folder = path.join(proj, `d${i % 5}`, `e${i % 3}`);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, `f${i}.txt`), String(i));
    }
    const order = async () => (await new ZipKit().plan({ inputs: [proj], output: path.join(dir, "o.zip") })).entries.map((e) => e.archivePath);
    const first = await order();
    for (let run = 0; run < 3; run++) expect(await order()).toEqual(first);
    expect(first.indexOf("d0")).toBeLessThan(first.indexOf("d0/e0"));
    expect(first.indexOf("d0/e0")).toBeLessThan(first.indexOf("d0/e0/f0.txt"));
  });
});
