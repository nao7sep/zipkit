/**
 * The persisted format, pinned by saved samples. Every supported manifest
 * format has an archive the SDK wrote with it, kept in tests/fixtures: the
 * current code must still verify it and read what it says. And the current
 * writer must still say exactly that about the same tree, so a change that
 * alters what an archive records fails here, not in someone's archive.
 */

import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipKit } from "../src/index.js";
import { MANIFEST_FORMAT_VERSION } from "../src/write/metadata.js";
import { makeSampleTree, manifestEssentials, SAMPLE_POLICY } from "./fixtures/sample-tree.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SUPPORTED = Array.from({ length: MANIFEST_FORMAT_VERSION }, (_, i) => i + 1);
const expected = async (version: number): Promise<unknown> =>
  JSON.parse(await readFile(path.join(fixtures, `format-${version}.expected.json`), "utf8"));

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "zipkit-formats-")); });
afterEach(() => rm(root, { recursive: true, force: true }));

describe.each(SUPPORTED)("manifest format %i", (version) => {
  const archive = path.join(fixtures, `format-${version}.zip`);

  it("still verifies, entry by entry and against its manifest", async () => {
    const result = await new ZipKit().extract({ archive, dryRun: true, checkMetadata: true });
    expect(result.reportOk).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.entries.every((e) => e.crc === "ok" && (e.type !== "file" || e.archivePath === "zipkit.json" || e.sha === "ok"))).toBe(true);
  });

  it("still reads as it was written", async () => {
    const manifest = await new ZipKit().readManifest(archive);
    expect(manifestEssentials(manifest as never)).toEqual(await expected(version));
  });
});

// A name Windows forbids cannot be created on Windows, so the tree cannot be made there.
it.skipIf(process.platform === "win32")("the current writer records the sample tree exactly as its saved sample does", async () => {
  const tree = await makeSampleTree(root);
  const archive = path.join(root, "now.zip");
  await new ZipKit().create({ inputs: [tree], output: archive, policy: SAMPLE_POLICY });
  const manifest = await new ZipKit().readManifest(archive);
  expect(manifestEssentials(manifest as never)).toEqual(await expected(MANIFEST_FORMAT_VERSION));
  // The entries themselves too: the same names, kinds, methods, sizes, checksums and times.
  const listing = async (file: string) => (await new ZipKit().list(file, { timeZone: "UTC" })).entries
    .filter((e) => e.archivePath !== "zipkit.json")
    .map(({ archivePath, type, method, size, crc32, modified }) => ({ archivePath, type, method, size, crc32, modified }))
    .sort((a, b) => (a.archivePath < b.archivePath ? -1 : 1));
  expect(await listing(archive)).toEqual(await listing(path.join(fixtures, `format-${MANIFEST_FORMAT_VERSION}.zip`)));
});
