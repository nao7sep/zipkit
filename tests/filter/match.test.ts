/**
 * Selection engine tests: gitignore-flavoured glob anchoring, the `**`
 * span, regex and literal dialects, dotfile matching, target applicability, and
 * first-match-wins with user rules ranked above the junk preset.
 */

import { describe, expect, it } from "vitest";
import { buildMatcher } from "../../src/filter/match.js";
import { resolvePolicy } from "../../src/policy.js";
import type { FilterRule } from "../../src/types.js";

function matcher(filters: FilterRule[], junk: "builtin" | "none" = "none") {
  return buildMatcher(resolvePolicy(undefined, { junk, filters }));
}

function rule(over: Partial<FilterRule> & { pattern: string }): FilterRule {
  return {
    action: over.action ?? "exclude",
    pattern: over.pattern,
    match: over.match ?? "glob",
    target: over.target ?? "both",
  };
}

describe("glob matching", () => {
  it("matches an unanchored pattern at any depth", () => {
    const m = matcher([rule({ pattern: "*.tmp" })]);
    expect(m.match("a.tmp", false)?.action).toBe("exclude");
    expect(m.match("x/y/a.tmp", false)?.action).toBe("exclude");
    expect(m.match("a.txt", false)).toBeNull();
  });

  it("anchors a leading-slash pattern to the root", () => {
    const m = matcher([rule({ pattern: "/build" })]);
    expect(m.match("build", true)?.action).toBe("exclude");
    expect(m.match("x/build", true)).toBeNull();
  });

  it("anchors a pattern that contains an interior slash", () => {
    const m = matcher([rule({ pattern: "src/gen" })]);
    expect(m.match("src/gen", true)?.action).toBe("exclude");
    expect(m.match("a/src/gen", true)).toBeNull();
  });

  it("spans segments with a globstar", () => {
    const m = matcher([rule({ pattern: "a/**/c" })]);
    expect(m.match("a/c", false)?.action).toBe("exclude");
    expect(m.match("a/b/c", false)?.action).toBe("exclude");
    expect(m.match("a/b/d/c", false)?.action).toBe("exclude");
  });

  it("respects target applicability", () => {
    const m = matcher([rule({ pattern: "node_modules", target: "dir" })]);
    expect(m.match("node_modules", true)?.action).toBe("exclude");
    expect(m.match("node_modules", false)).toBeNull();
  });
});

describe("regex and literal dialects", () => {
  it("matches a regex anywhere unless anchored", () => {
    const m = matcher([rule({ pattern: "\\.log$", match: "regex" })]);
    expect(m.match("a.log", false)?.action).toBe("exclude");
    expect(m.match("a.log.txt", false)).toBeNull();
  });

  it("matches a literal path exactly when anchored by an interior slash", () => {
    const m = matcher([rule({ pattern: "exact/name", match: "literal" })]);
    expect(m.match("exact/name", false)?.action).toBe("exclude");
    expect(m.match("x/exact/name", false)).toBeNull();
  });

  it("matches an unanchored literal as a trailing path component", () => {
    const m = matcher([rule({ pattern: "name", match: "literal" })]);
    expect(m.match("name", false)?.action).toBe("exclude");
    expect(m.match("a/name", false)?.action).toBe("exclude");
    expect(m.match("named", false)).toBeNull();
  });
});

describe("junk preset and ordering", () => {
  it("matches dotfile junk at any depth with the right rule id", () => {
    const m = matcher([], "builtin");
    expect(m.match(".DS_Store", false)?.junkRule).toBe("macos.junk");
    expect(m.match("a/.DS_Store", false)?.junkRule).toBe("macos.junk");
    expect(m.match("Thumbs.db", false)?.junkRule).toBe("windows.junk");
  });

  it("treats trailing-slash junk as directory-only", () => {
    const m = matcher([], "builtin");
    expect(m.match("__MACOSX", true)?.junkRule).toBe("macos.junk");
    expect(m.match("__MACOSX", false)).toBeNull();
  });

  it("lets a user include rescue a junk-listed file (first-match-wins)", () => {
    const m = matcher([rule({ action: "include", pattern: ".DS_Store" })], "builtin");
    expect(m.match(".DS_Store", false)?.action).toBe("include");
  });

  it("returns null when nothing matches (entry is included by default)", () => {
    const m = matcher([rule({ pattern: "*.tmp" })], "builtin");
    expect(m.match("keep.txt", false)).toBeNull();
  });
});
