/**
 * Selection pass (pass 2), tested directly against a stub matcher so the pass
 * itself is locked independent of the picomatch compiler. The first matching
 * rule excludes the entry, sets its `excludeReason` to the rule description, and
 * stops it being emitted; a junk-preset rule additionally emits its
 * `*.junk` info finding while a plain user rule emits none. A non-match leaves
 * the entry in, and an already-excluded entry is skipped.
 */

import { describe, expect, it } from "vitest";
import type { CompiledRule, FilterMatcher } from "../../../src/sdk/filter/match.js";
import { applyFilter } from "../../../src/sdk/plan/filterPass.js";
import { workItem } from "../../helpers/synthetic.js";

/** A matcher that returns the given rule for an exact path, null otherwise. */
function matcherFor(path: string, rule: CompiledRule): FilterMatcher {
  return { match: (p) => (p === path ? rule : null) };
}

describe("applyFilter", () => {
  it("excludes a junk match with the preset's info finding", () => {
    const rule: CompiledRule = {
      target: "file",
      test: () => true,
      junkRule: "macos.junk",
      describe: "junk: .DS_Store",
    };
    const item = workItem({ archivePath: ".DS_Store" });
    applyFilter([item], matcherFor(".DS_Store", rule));
    expect(item.excluded).toBe(true);
    expect(item.emitExplicit).toBe(false);
    expect(item.excludeReason).toBe("junk: .DS_Store");
    expect(item.findings.map((f) => f.rule)).toEqual(["macos.junk"]);
  });

  it("excludes a user-rule match with no finding", () => {
    const rule: CompiledRule = { target: "file", test: () => true, describe: "exclude rule: *.tmp" };
    const item = workItem({ archivePath: "scratch.tmp" });
    applyFilter([item], matcherFor("scratch.tmp", rule));
    expect(item.excluded).toBe(true);
    expect(item.excludeReason).toBe("exclude rule: *.tmp");
    expect(item.findings).toEqual([]);
  });

  it("leaves a non-matching entry included", () => {
    const rule: CompiledRule = { target: "file", test: () => true, describe: "exclude rule: *.tmp" };
    const item = workItem({ archivePath: "keep.txt" });
    applyFilter([item], matcherFor("scratch.tmp", rule));
    expect(item.excluded).toBe(false);
    expect(item.findings).toEqual([]);
  });

  it("skips an already-excluded entry without consulting the matcher", () => {
    const item = workItem({ archivePath: "gone.txt", excluded: true, excludeReason: "pruned" });
    let consulted = false;
    applyFilter([item], {
      match: () => {
        consulted = true;
        return null;
      },
    });
    expect(consulted).toBe(false);
    expect(item.excludeReason).toBe("pruned");
  });
});
