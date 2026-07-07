/**
 * Symlink policy (pass 8), tested directly. Whatever still reaches here as a
 * `symlink` is a portability defect, so both modes raise `entry.symlink`:
 * `preserve` stores it as a Unix link entry (emitted, stored, loud warning),
 * while the default `ignore` excludes it. Non-symlink entries and already
 * excluded links are untouched.
 */

import { describe, expect, it } from "vitest";
import { applySymlinks } from "../../../src/sdk/plan/symlinks.js";
import { resolvePolicy } from "../../../src/sdk/policy.js";
import { workItem } from "../../helpers/synthetic.js";

describe("applySymlinks", () => {
  it("preserves a link as an emitted, stored Unix entry with a warning", () => {
    const items = [workItem({ archivePath: "link", type: "symlink" })];
    applySymlinks(items, resolvePolicy(undefined, { symlinks: "preserve" }));
    expect(items[0]!.excluded).toBe(false);
    expect(items[0]!.emitExplicit).toBe(true);
    expect(items[0]!.method).toBe("store");
    expect(items[0]!.findings.map((f) => f.rule)).toEqual(["entry.symlink"]);
    expect(items[0]!.findings[0]!.message).toMatch(/preserved as a Unix link entry/);
  });

  it("excludes a link under the default ignore policy", () => {
    const items = [workItem({ archivePath: "link", type: "symlink" })];
    applySymlinks(items, resolvePolicy(undefined, {}));
    expect(items[0]!.excluded).toBe(true);
    expect(items[0]!.emitExplicit).toBe(false);
    expect(items[0]!.excludeReason).toMatch(/symlink ignored/);
    expect(items[0]!.findings.map((f) => f.rule)).toEqual(["entry.symlink"]);
  });

  it("leaves non-symlink entries alone", () => {
    const items = [workItem({ archivePath: "a.txt" }), workItem({ archivePath: "d", type: "dir" })];
    applySymlinks(items, resolvePolicy(undefined, { symlinks: "preserve" }));
    expect(items[0]!.findings).toEqual([]);
    expect(items[1]!.findings).toEqual([]);
  });

  it("skips an already-excluded link", () => {
    const items = [
      workItem({ archivePath: "link", type: "symlink", excluded: true, excludeReason: "filtered" }),
    ];
    applySymlinks(items, resolvePolicy(undefined, { symlinks: "preserve" }));
    expect(items[0]!.findings).toEqual([]);
    expect(items[0]!.emitExplicit).toBe(false);
  });
});
