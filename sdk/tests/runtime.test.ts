/**
 * The package runs as written: every entry it exports loads on the plain
 * Node runtime with type stripping, the way a script consumes it, with no
 * bundler or test runner resolving anything for it.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const PACKAGE = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const exportsMap = JSON.parse(readFileSync(path.join(PACKAGE, "package.json"), "utf8")).exports as Record<string, string>;
const entries = Object.entries(exportsMap).filter(([, file]) => file.endsWith(".ts"));

it.each(entries)("loads the %s entry on plain Node", async (_name, file) => {
  const url = pathToFileURL(path.join(PACKAGE, file)).href;
  const { stdout } = await run(process.execPath, [
    "--input-type=module",
    "-e",
    `const m = await import(${JSON.stringify(url)}); console.log(Object.keys(m).length);`,
  ]);
  expect(Number(stdout.trim())).toBeGreaterThanOrEqual(0);
});

it("loads by its package name from the app's workspace, through the link npm makes", async () => {
  const { stdout } = await run(process.execPath, [
    "--input-type=module",
    "-e",
    'const m = await import("zipkitsdk"); console.log(typeof m.ZipKit);',
  ], { cwd: path.dirname(PACKAGE) });
  expect(stdout.trim()).toBe("function");
});
