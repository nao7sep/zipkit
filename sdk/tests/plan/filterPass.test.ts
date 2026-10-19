/**
 * Selection pass (pass 2), tested directly against a stub matcher so the pass
 * itself is locked independent of the picomatch compiler. The first matching
 * rule excludes the entry, sets its `excludeReason` to the rule description, and
 * stops it being emitted; a junk-preset rule additionally emits its
 * `*.junk` info finding while a plain user rule emits none. A non-match leaves
 * the entry in, and an already-excluded entry is skipped.
 */

import { describe, expect, it } from "vitest";
import { describePattern, type CompiledRule, type FilterMatcher } from "../../src/filter/match.ts";
import { applyFilter } from "../../src/plan/filterPass.ts";
import { workItem } from "../helpers/synthetic.ts";

/** A matcher that returns the given rule for an exact path, null otherwise. */
function matcherFor(path: string, rule: CompiledRule): FilterMatcher {
  return { match: (p) => (p === path ? rule : null) };
}

describe("applyFilter", () => {
  it("excludes a match with an info finding naming the pattern", () => {
    const pattern = { pattern: ".DS_Store", match: "glob" as const, target: "both" as const, ignoreCase: true, label: "macOS" };
    const rule: CompiledRule = { target: "file", test: () => true, pattern, describe: describePattern(pattern) };
    const item = workItem({ archivePath: ".DS_Store" });
    applyFilter([item], matcherFor(".DS_Store", rule));
    expect(item.excluded).toBe(true);
    expect(item.emitExplicit).toBe(false);
    expect(item.excludeCode).toBe("pattern");
    expect(item.excludeReason).toBe("pattern .DS_Store (macOS)");
    expect(item.findings).toEqual([expect.objectContaining({ rule: "exclude.pattern", severity: "info", message: "excluded by pattern .DS_Store (macOS)" })]);
  });

  it("leaves a non-matching entry included", () => {
    const pattern = { pattern: "*.tmp", match: "glob" as const, target: "both" as const, ignoreCase: false };
    const rule: CompiledRule = { target: "file", test: () => true, pattern, describe: describePattern(pattern) };
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
