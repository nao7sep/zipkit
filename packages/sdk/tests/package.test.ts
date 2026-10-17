/**
 * The package as it ships: the SDK and the CLI built to JavaScript with type
 * declarations, run by Node itself rather than through the test runner, so a
 * source that only the bundler or the test runner can resolve fails here.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as source from "../src/index.js";

const run = promisify(execFile);
// Inside the package, so the built files resolve its dependencies.
const built = path.resolve(`.package-test-${process.pid}`);
let work: string;

beforeAll(async () => {
  // TypeScript exports no path to its command; it sits beside its package.json.
  const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
  await run(process.execPath, [tsc, "-p", "tsconfig.json", "--outDir", built]);
  work = await mkdtemp(path.join(tmpdir(), "zipkit-package-"));
}, 60_000);
afterAll(async () => {
  await rm(built, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

it("exports from the built entry what the source entry exports, with declarations", async () => {
  const entry = await import(path.join(built, "index.js"));
  expect(Object.keys(entry).sort()).toEqual(Object.keys(source).sort());
  expect(await readFile(path.join(built, "index.d.ts"), "utf8")).toContain("ZipKit");
  // The other entries the package exports.
  expect(Object.keys(await import(path.join(built, "testing.js"))).sort()).toEqual(["Volume", "nodeFileSystem"]);
  expect(await readFile(path.join(built, "types.d.ts"), "utf8")).toContain("export interface ArchiveSpec");
});

it("runs the built CLI with Node: create, then verify", async () => {
  const input = path.join(work, "proj");
  await mkdir(input);
  await writeFile(path.join(input, "a.txt"), "alpha");
  const cli = path.join(built, "cli", "zipkit.js");
  const output = path.join(work, "proj.zip");
  const created = await run(process.execPath, [cli, "create", input, "-o", output]);
  expect(created.stdout).toContain(`Wrote ${output}`);
  const verified = await run(process.execPath, [cli, "verify", output]);
  expect(verified.stdout).toBe("OK: 2 entries verified against the manifest\n");
  await expect(run(process.execPath, [cli, "verify", path.join(work, "none.zip")])).rejects.toMatchObject({ code: 6 });
});

it("points the package's entry, types and command at the build", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  expect(pkg.exports["."]).toMatchObject({ types: "./dist/index.d.ts", import: "./dist/index.js" });
  expect(pkg.bin).toEqual({ zipkit: "./dist/cli/zipkit.js" });
});
