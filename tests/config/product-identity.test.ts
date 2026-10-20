import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_NAME } from "../../src/gui/shared/identity";

// package.json's productName is the one source of the app's name, and its
// engines field of the Node it needs; every copy is held to them here.
const read = (file: string): string => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const app = JSON.parse(read("package.json")) as { productName: string; engines: { node: string } };

describe("the product name", () => {
  it("is the app's own name", () => {
    expect(APP_NAME).toBe(app.productName);
  });

  it.each(["run-built.command", "rebuild.command", "run-built.ps1", "rebuild.ps1"])("is the one %s names the built app by", (launcher) => {
    const names = [...read(`scripts/${launcher}`).matchAll(/^\$?(?:APP_NAME|appName)\s*=\s*"([^"]*)"/gm)].map((m) => m[1]);
    expect(names).toEqual([app.productName]);
  });
});

describe("the Node version", () => {
  it("is the same for the app and the SDK it bundles", () => {
    expect(JSON.parse(read("sdk/package.json")).engines.node).toBe(app.engines.node);
  });
});
