/**
 * The docs name every identifier a result can carry and every command-line
 * option, so a rule, code or option added without its documentation fails
 * here rather than surprising an app.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RULE_REGISTRY, ZipKit } from "../src/sdk/index.js";
import * as sdk from "../src/sdk/index.js";

const doc = (name: string) => readFileSync(path.join("docs", name), "utf8");
const missing = (text: string, ids: Iterable<string>) => [...ids].filter((id) => !text.includes(`\`${id}\``));
const types = readFileSync("src/sdk/types.ts", "utf8");
/** The members of a string-literal union type declared in types.ts. */
function union(name: string): string[] {
  const body = new RegExp(`export type ${name} =([^;]+);`).exec(types)?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("docs/rules.md", () => {
  const rules = doc("rules.md");
  it("lists every plan rule, read rule and exclusion code", () => {
    expect(missing(rules, Object.keys(RULE_REGISTRY))).toEqual([]);
    expect(union("ExtractRuleId")).toHaveLength(6);
    expect(missing(rules, union("ExtractRuleId"))).toEqual([]);
    expect(missing(rules, union("ExcludeCode"))).toEqual([]);
  });

  it("lists every error code the SDK throws", () => {
    const source = (readdirSync("src/sdk", { recursive: true, encoding: "utf8" }) as string[])
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(path.join("src/sdk", file), "utf8"))
      .join("\n");
    const codes = new Set([...source.matchAll(/\w+Error\(\s*"([a-z0-9]+\.[a-z0-9.-]+)"/g)].map((m) => m[1]!));
    codes.add("aborted").add("io.stalled");
    expect(codes.size).toBeGreaterThan(25);
    expect(missing(rules, codes)).toEqual([]);
  });
});

describe("docs/sdk.md", () => {
  it("names every runtime export and every ZipKit method", () => {
    const guide = doc("sdk.md");
    const exports = Object.keys(sdk).filter((name) => !/Error$/.test(name));
    const methods = Object.getOwnPropertyNames(ZipKit.prototype).filter((name) => name !== "constructor");
    expect(exports.filter((name) => !guide.includes(name))).toEqual([]);
    expect(methods.filter((name) => !guide.includes(`${name}(`))).toEqual([]);
    for (const error of Object.keys(sdk).filter((name) => /Error$/.test(name) && name !== "ZipKitError")) expect(guide).toContain(error);
  });
});

describe("docs/cli.md", () => {
  it("documents every option the command takes", () => {
    const cli = doc("cli.md");
    const options = [...readFileSync("src/cli/run.ts", "utf8").matchAll(/^ {2}"?([a-z-]+)"?: \{ type:/gm)].map((m) => m[1]!)
      .filter((name) => !["help", "version"].includes(name));
    expect(options.length).toBeGreaterThan(10);
    expect(options.filter((name) => !cli.includes(`--${name}`))).toEqual([]);
  });
});
