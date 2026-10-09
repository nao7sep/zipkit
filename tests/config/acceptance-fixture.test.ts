/**
 * The acceptance fixture script builds what the checks need, refuses a folder it
 * did not make, and deletes only its own folder.
 */

import { lstat, mkdtemp, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
// @ts-expect-error -- a plain .mjs script with no type declarations
import { cleanFixture, makeFixture, MARKER } from "../../scripts/make-acceptance-fixture.mjs";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zipkit-fixture-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("writes NFD names, a bundle, a broken link and, where possible, a named pipe, beside an empty data folder", async () => {
  const dir = path.join(root, "fixture");
  const made = await makeFixture(dir);

  const names = await readdir(path.join(made.inputs, "zipkit-fixture-names"));
  expect(names).toContain("パスポート.pdf".normalize("NFD"));
  expect(names.some((name) => name.includes(":") && name !== name.normalize("NFC"))).toBe(true);
  const bundle = path.join(made.inputs, "zipkit-fixture-bundle", "データ".normalize("NFD"), "企画.pages");
  expect((await stat(path.join(bundle, "Data", "preview.png"))).isFile()).toBe(true);
  const special = path.join(made.inputs, "zipkit-fixture-special");
  expect(await readlink(path.join(special, "broken-link"))).toBe("missing-target");
  await expect(stat(path.join(special, "broken-link"))).rejects.toThrow();
  if (made.fifo) expect((await lstat(path.join(special, "pipe"))).isFIFO()).toBe(true);
  expect(await readdir(made.data)).toEqual([]);
  expect(await readdir(dir)).toContain(MARKER);
});

it("rebuilds its own folder but refuses a folder that holds anything else", async () => {
  const dir = path.join(root, "fixture");
  await makeFixture(dir);
  await expect(makeFixture(dir)).resolves.toMatchObject({ dir });

  const other = path.join(root, "other");
  await makeFixture(path.join(other, "inner"));
  await writeFile(path.join(root, "mine.txt"), "not the fixture's");
  await expect(makeFixture(root)).rejects.toThrow("not an acceptance fixture");
  expect(await readdir(root)).toContain("mine.txt");
});

it("deletes only a folder carrying its marker", async () => {
  const dir = path.join(root, "fixture");
  await makeFixture(dir);
  await cleanFixture(dir);
  await expect(stat(dir)).rejects.toThrow();

  await writeFile(path.join(root, "keep.txt"), "x");
  await expect(cleanFixture(root)).rejects.toThrow("nothing was deleted");
  expect(await readdir(root)).toContain("keep.txt");
});
