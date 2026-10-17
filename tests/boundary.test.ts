/**
 * The app's side of the SDK boundary: the SDK is a package of its own
 * (packages/sdk), and the app reaches it by name only, through the entries
 * the package exports, never by a path into it. The app bundles the SDK's
 * source but loads the SDK's dependencies at run time, so it declares each of
 * them itself, or the packaged app would lack one.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Every module named by an import or export in the TypeScript under `dirs`. */
function imports(dirs: string[]): Array<{ file: string; spec: string }> {
  return dirs.flatMap((dir) => (readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[])
    .filter((file) => /\.(ts|tsx|mts)$/.test(file))
    .map((file) => path.join(dir, file))
    .flatMap((file) => {
      const code = stripComments(readFileSync(file, "utf8"));
      const found = [
        ...code.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm),
        ...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
        ...code.matchAll(/\bvi\.mock\(\s*["']([^"']+)["']/g),
      ];
      return found.map((m) => ({ file, spec: m[1]! }));
    }));
}

/** Whether a specifier reaches into the SDK's package other than by name. */
function intoPackage(file: string, spec: string): boolean {
  if (!spec.startsWith(".")) return /^zipkit\/(?!types$|testing$)/.test(spec);
  return path.resolve(path.dirname(file), spec).startsWith(path.resolve("packages", "sdk"));
}

describe("the app's side of the SDK boundary", () => {
  it("reaches the SDK by name from the app: the entry, and its types where Node is not loaded", () => {
    const offenders = imports(["src"]).filter(({ file, spec }) =>
      intoPackage(file, spec) || spec === "zipkit/testing" ||
      (spec === "zipkit" && !file.startsWith(path.join("src", "gui", "main"))));
    expect(offenders).toEqual([]);
  });

  it("reaches the SDK by name from the tests too, with its testing entry", () => {
    expect(imports(["tests"]).filter(({ file, spec }) => intoPackage(file, spec))).toEqual([]);
  });

  it("declares every dependency of the SDK it bundles, and depends on the SDK only to build", () => {
    const app = JSON.parse(readFileSync("package.json", "utf8"));
    const sdk = JSON.parse(readFileSync(path.join("packages", "sdk", "package.json"), "utf8"));
    expect(Object.keys(sdk.dependencies).filter((name) => !(name in app.dependencies))).toEqual([]);
    expect(app.devDependencies.zipkit).toBe(sdk.version);
    expect(app.dependencies.zipkit).toBeUndefined();
  });
});
