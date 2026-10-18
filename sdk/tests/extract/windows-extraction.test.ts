/** Exercise Windows naming through the real extraction pipeline on every host.
 * Only platform selection is simulated; archive bytes and filesystem writes are
 * real. The native Windows test still owns NTFS/device/long-path qualification. */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ZipKit } from "../../src/index.ts";
import { buildZipFile, type EntryWithData } from "../helpers/writeZip.ts";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "zk-win-extraction-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function entry(name: string, type: "file" | "dir" = "file"): EntryWithData {
  const raw = type === "file" ? Buffer.from(name) : Buffer.alloc(0);
  return { name, type, raw, method: "store", uncompressedSize: raw.length,
    mtimeNs: 1_577_836_800_000_000_000n, atimeNs: 1_577_836_800_000_000_000n,
    birthtimeNs: 1_577_836_800_000_000_000n, mode: type === "dir" ? 0o755 : 0o644 };
}

async function archive(entries: EntryWithData[]): Promise<string> {
  return (await buildZipFile(entries, { timeZone: "UTC", chunkSize: 65536 })).path;
}

async function extractWindows(input: string, options: { dryRun?: boolean; overwrite?: boolean } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    return await new ZipKit().extract({ archive: input, dest: path.join(dir, "out"), ...options });
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

it.each([
  ["reserved device", "CON.txt", "CON_.txt"],
  ["alternate stream", "notes:stream", "notes_stream"],
  ["trimmed suffix", "report. ", "report"],
  ["renamed parent", "dir:1/a.txt", "dir_1/a.txt"],
])("rejects the %s collision before creating the destination", async (_label, first, second) => {
  const input = await archive([entry(first), entry(second)]);
  await expect(extractWindows(input)).rejects.toMatchObject({ code: "read.target-collision" });
  await expect(stat(path.join(dir, "out"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects a renamed file that would become another entry's parent", async () => {
  const input = await archive([entry("dir:1"), entry("dir_1/child.txt")]);
  await expect(extractWindows(input)).rejects.toMatchObject({ code: "read.target-collision" });
  await expect(stat(path.join(dir, "out"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("writes a renamed directory and its children, reporting their actual destinations", async () => {
  const input = await archive([entry("dir:1", "dir"), entry("dir:1/aux.txt"), entry("dir:1/notes:stream")]);
  const report = await extractWindows(input);
  expect(report.reportOk).toBe(true);
  for (const [source, target] of [["dir:1", "dir_1"], ["dir:1/aux.txt", "dir_1/aux_.txt"],
    ["dir:1/notes:stream", "dir_1/notes_stream"]] as const) {
    expect(report.entries.find((item) => item.archivePath === source)?.outputPath).toBe(path.join(dir, "out", target));
  }
  expect((await readdir(path.join(dir, "out", "dir_1"))).sort()).toEqual(["aux_.txt", "notes_stream"]);
  expect(await readFile(path.join(dir, "out", "dir_1", "notes_stream"), "utf8")).toBe("dir:1/notes:stream");
});

it("protects an existing renamed destination unless overwrite is requested", async () => {
  const input = await archive([entry("notes:stream")]);
  await extractWindows(input);
  const target = path.join(dir, "out", "notes_stream");
  await writeFile(target, "existing work");
  const kept = await extractWindows(input);
  expect(kept.entries[0]?.skipped).toBe("exists");
  expect(await readFile(target, "utf8")).toBe("existing work");
  await extractWindows(input, { overwrite: true });
  expect(await readFile(target, "utf8")).toBe("notes:stream");
});

it("validates Windows names in dry-run without creating a destination", async () => {
  const input = await archive([entry("dir:1/aux.txt")]);
  const report = await extractWindows(input, { dryRun: true });
  expect(report.reportOk).toBe(true);
  expect(report.wrote).toBe(false);
  await expect(stat(path.join(dir, "out"))).rejects.toMatchObject({ code: "ENOENT" });
});
