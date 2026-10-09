#!/usr/bin/env node
/**
 * Builds the disposable folder ZipKit's acceptance checks run against: inputs
 * whose names and kinds exercise name fixing, bundles and exclusions, and an
 * empty data folder to start ZipKit with. It never touches the real ~/.zipkit.
 *
 *   node scripts/make-acceptance-fixture.mjs [folder] [--large]
 *   node scripts/make-acceptance-fixture.mjs --clean <folder>
 *
 * With no folder it makes a new one under the system temp folder. A folder that
 * already holds anything is used only when it carries this script's marker, and
 * --clean deletes only such a folder. Files a check moves to the Trash leave the
 * folder for the system Trash; their names start with "zipkit-fixture-" so they
 * can be found there.
 */

import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MARKER = ".zipkit-acceptance-fixture";

/** Japanese names written in NFD, as macOS writes them, so ZipKit's NFC fix shows. */
const nfd = (name) => name.normalize("NFD");

async function isMarked(dir) {
  return stat(path.join(dir, MARKER)).then(() => true, () => false);
}

async function prepare(dir) {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  if (entries.length > 0 && !(await isMarked(dir))) {
    throw new Error(`${dir} is not empty and is not an acceptance fixture; choose an empty folder`);
  }
  await rm(path.join(dir, "inputs"), { recursive: true, force: true });
  await rm(path.join(dir, "data"), { recursive: true, force: true });
  await writeFile(path.join(dir, MARKER), "Made by scripts/make-acceptance-fixture.mjs. Safe to delete.\n");
}

/**
 * Write the fixture into `dir` and return what it made. `fifo` is false where the
 * platform has no named pipes (Windows); `large` adds a 256 MiB file for the
 * "grow a file during Create" check.
 */
export async function makeFixture(dir, { large = false } = {}) {
  await prepare(dir);
  const inputs = path.join(dir, "inputs");
  await mkdir(path.join(dir, "data"));

  const files = path.join(inputs, "zipkit-fixture-names");
  await mkdir(files, { recursive: true });
  await writeFile(path.join(files, nfd("パスポート.pdf")), "an NFD-only name\n");
  await writeFile(path.join(files, nfd("ガイド.txt")), "an NFD-only name\n");
  // NFD and a Windows-invalid character in one name: two fixes, marked separately.
  await writeFile(path.join(files, `${nfd("ゲーム")}:draft.txt`), "a mixed rename\n");
  await writeFile(path.join(files, "plain.txt"), "a name that needs nothing\n");

  // A renamed folder holding a package bundle, which ZipKit keeps as one unit.
  const bundle = path.join(inputs, "zipkit-fixture-bundle", nfd("データ"), "企画.pages");
  await mkdir(path.join(bundle, "Data"), { recursive: true });
  await writeFile(path.join(bundle, "index.xml"), "<document/>\n");
  await writeFile(path.join(bundle, "Data", "preview.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const special = path.join(inputs, "zipkit-fixture-special");
  await mkdir(special, { recursive: true });
  await writeFile(path.join(special, "kept.txt"), "kept beside the excluded entries\n");
  // A link to nothing: an excluded entry with an info finding.
  await symlink("missing-target", path.join(special, "broken-link"));
  // A named pipe: an excluded entry with an info finding. Windows has none.
  let fifo = false;
  if (process.platform !== "win32") {
    const made = spawnSync("mkfifo", [path.join(special, "pipe")]);
    fifo = made.status === 0;
  }

  if (large) {
    const grow = path.join(inputs, "zipkit-fixture-large");
    await mkdir(grow, { recursive: true });
    await writeFile(path.join(grow, "grows-during-create.bin"), Buffer.alloc(256 * 1024 * 1024));
  }

  return { dir, inputs, data: path.join(dir, "data"), fifo };
}

/** Delete a fixture folder, refusing any folder without the marker. */
export async function cleanFixture(dir) {
  if (!(await isMarked(dir))) throw new Error(`${dir} is not an acceptance fixture; nothing was deleted`);
  // A check may have left a folder read-only; make it writable so it can go.
  const unlock = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      await chmod(child, 0o755).catch(() => {});
      await unlock(child);
    }
  };
  await unlock(dir);
  await rm(dir, { recursive: true, force: true });
}

async function main(argv) {
  if (argv[0] === "--clean") {
    if (!argv[1]) throw new Error("--clean needs the fixture folder");
    await cleanFixture(path.resolve(argv[1]));
    process.stdout.write(`Deleted ${path.resolve(argv[1])}\n`);
    return;
  }
  const large = argv.includes("--large");
  const given = argv.find((arg) => !arg.startsWith("--"));
  const dir = given ? path.resolve(given) : await mkdtemp(path.join(tmpdir(), "zipkit-acceptance-"));
  const made = await makeFixture(dir, { large });
  process.stdout.write(
    [
      `Fixture: ${made.dir}`,
      `Inputs:  ${made.inputs}`,
      `Start ZipKit on the empty data folder: ZIPKIT_DATA_DIR="${made.data}" npm run dev`,
      made.fifo ? "" : "No named pipe on this platform; the FIFO check is skipped.",
      `Delete it afterwards: node scripts/make-acceptance-fixture.mjs --clean "${made.dir}"`,
      "",
    ].filter((line, index, all) => line !== "" || index === all.length - 1).join("\n"),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
