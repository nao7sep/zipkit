/**
 * The SDK as a library any app can consume: it reads nothing ambient (no
 * environment, no working directory, no home or temp folder of its own),
 * prints nothing, names no app's storage, and imports nothing from outside its
 * own package but its declared dependencies. A source check, so a change that
 * bends any of this fails here rather than surfacing in another app.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve("src");
const sources = (readdirSync(SRC, { recursive: true, encoding: "utf8" }) as string[])
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({ file, code: stripComments(readFileSync(path.join(SRC, file), "utf8")) }));
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Every module a source names in an import or export. */
function specifiers(code: string): string[] {
  const statements = [...code.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)];
  const bare = [...code.matchAll(/^\s*import\s+["']([^"']+)["']/gm)];
  const dynamic = [...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)];
  return [...statements, ...bare, ...dynamic].map((m) => m[1]!);
}

describe("the SDK boundary", () => {
  it("reads no environment variable and prints nothing", () => {
    const offenders = sources.filter(({ code }) => /process\.env|process\.std(out|err)|console\./.test(code)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("imports nothing outside its package but Node and its declared dependencies", () => {
    const offenders = sources.flatMap(({ file, code }) => specifiers(code).flatMap((spec) => {
      if (spec.startsWith("node:")) return [];
      if (spec.startsWith(".")) {
        const target = path.resolve(SRC, path.dirname(file), spec);
        return target.startsWith(SRC + path.sep) ? [] : [`${file}: ${spec}`];
      }
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
      return name in pkg.dependencies ? [] : [`${file}: ${spec}`];
    }));
    expect(offenders).toEqual([]);
  });

  it("names no app's storage", () => {
    expect(sources.filter(({ code }) => /\.zipkit\b(?!\.json)|ZIPKIT_/.test(code)).map(({ file }) => file)).toEqual([]);
  });
});
