/**
 * The SDK as a library any app can consume: it reads no environment variable,
 * prints nothing, keeps no app's folders of its own, and imports nothing from
 * an app. A source check, so a change that bends any of this fails here
 * rather than surfacing in another app.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SDK = path.resolve("src/sdk");
const sources = (readdirSync(SDK, { recursive: true, encoding: "utf8" }) as string[])
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({ file, code: stripComments(readFileSync(path.join(SDK, file), "utf8")) }));

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("the SDK boundary", () => {
  it("reads no environment variable and prints nothing", () => {
    const offenders = sources.filter(({ code }) => /process\.env|process\.std(out|err)|console\./.test(code)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("imports nothing from an app, Electron or ZipKit's own storage", () => {
    const offenders = sources
      .filter(({ code }) => /from\s+["'](?:\.\.\/)+gui\/|from\s+["']electron["']|\.zipkit/.test(code))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});

/** Every import of the SDK in `dir` that `allowed` does not accept. */
function sdkImports(dir: string, allowed: RegExp): string[] {
  const root = path.resolve(dir);
  return (readdirSync(root, { recursive: true, encoding: "utf8" }) as string[])
    .filter((file) => /\.tsx?$/.test(file))
    .flatMap((file) => [...stripComments(readFileSync(path.join(root, file), "utf8")).matchAll(/from\s+["']((?:\.\.\/)+sdk\/[^"']+)["']/g)]
      .map((match) => match[1]!)
      .filter((spec) => !allowed.test(spec))
      .map((spec) => `${file}: ${spec}`));
}

describe("the apps' side of the boundary", () => {
  it("holds the desktop app to the SDK's public entry", () => {
    expect(sdkImports("src/gui", /\/sdk\/(index|types)\.(js|ts)$/)).toEqual([]);
  });

  it("holds the CLI to the public entry alone, as any outside app is", () => {
    expect(sdkImports("src/cli", /\/sdk\/index\.js$/)).toEqual([]);
  });
});
