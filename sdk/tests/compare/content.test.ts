/** Only calculate checksums used by matching candidate records, with one source read. */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recheckContent } from "../../src/compare/content.ts";
import { scanEntry } from "../helpers/synthetic.ts";
import { realVolume } from "../helpers/volume.ts";

vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});
vi.mock("node:zlib", async (original) => {
  const actual = await original<typeof import("node:zlib")>();
  return { ...actual, crc32: vi.fn(actual.crc32) };
});

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "zk-digest-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it.each(["file", "symlink"] as const)("selects SHA-only, CRC-only or mixed digests for a %s", async (type) => {
  const bytes = Buffer.from("content");
  const absolutePath = path.join(dir, "source");
  await writeFile(absolutePath, bytes);
  const source = scanEntry({ archivePath: "source", absolutePath, type, size: bytes.length, linkTarget: "content" });
  const entry = { ...source, method: "store" as const, originalPath: "source", nameFixes: [] };
  const sha = createHash("sha256").update(bytes).digest("hex");
  const crc = crc32(bytes);
  const base = { archivePath: "source", sourcePath: "source", type, size: bytes.length, mtime: { ns: source.mtimeNs.toString() }, crc32: crc };
  const deps = { volume: realVolume(), limit: <T>(run: () => Promise<T>) => run(), chunkSize: 65536 };
  for (const mode of ["sha", "crc", "mixed"] as const) {
    vi.mocked(createHash).mockClear();
    vi.mocked(crc32).mockClear();
    const records = mode === "sha" ? [{ ...base, sha256: sha }] : mode === "crc" ? [base] : [{ ...base, sha256: sha }, base];
    expect(await recheckContent([entry], records, deps)).toEqual([]);
    expect(createHash).toHaveBeenCalledTimes(mode === "crc" ? 0 : 1);
    expect(crc32).toHaveBeenCalledTimes(mode === "sha" ? 0 : 1);
    if (mode === "mixed") {
      // An unmatched SHA candidate cannot hide a matching CRC candidate.
      expect(await recheckContent([entry], [{ ...base, sha256: "0".repeat(64) }, base], deps)).toEqual([]);
      // Both candidates can each vouch for one source sharing the name.
      expect(await recheckContent([entry, entry], records, deps)).toEqual([]);
    }
  }
});
