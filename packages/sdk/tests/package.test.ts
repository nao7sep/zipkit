/**
 * The package as it ships: the SDK and the CLI built to JavaScript with type
 * declarations, run by Node itself rather than through the test runner, so a
 * source that only the bundler or the test runner can resolve fails here.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as source from "../src/sdk/index.js";

const run = promisify(execFile);
// Inside the repository, so the built files resolve its dependencies.
const built = path.resolve("out", `.package-test-${process.pid}`);
let work: string;

beforeAll(async () => {
  const tsc = path.resolve("node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  await run(tsc, ["-p", "tsconfig.sdk.json", "--outDir", built], { shell: process.platform === "win32" });
  work = await mkdtemp(path.join(tmpdir(), "zipkit-package-"));
}, 60_000);
afterAll(async () => {
  await rm(built, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

it("exports from the built entry what the source entry exports, with declarations", async () => {
  const entry = await import(path.join(built, "sdk", "index.js"));
  expect(Object.keys(entry).sort()).toEqual(Object.keys(source).sort());
  expect(await readFile(path.join(built, "sdk", "index.d.ts"), "utf8")).toContain("ZipKit");
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
  expect(pkg.exports["."]).toEqual({ types: "./dist/sdk/index.d.ts", import: "./dist/sdk/index.js" });
  expect(pkg.bin).toEqual({ zipkit: "./dist/cli/zipkit.js" });
});
