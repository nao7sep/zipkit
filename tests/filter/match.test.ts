/**
 * Exclusion engine tests — exercised hard, because archive paths are full of
 * edge cases. Covers gitignore-flavoured glob anchoring, the `**` span, glob
 * metacharacters, regex and literal dialects, dotfiles, case sensitivity,
 * target applicability, the junk preset, ordering/reporting, and the inclusive
 * default. The same engine backs both `create` and `extract`.
 */

import { describe, expect, it } from "vitest";
import { buildMatcher } from "../../src/filter/match.js";
import { globExclude, regexExclude } from "../../src/filter/rules.js";
import type { FilterRule } from "../../src/types.js";

function matcher(rules: FilterRule[], junk = false) {
  return buildMatcher(rules, junk);
}
function rule(over: Partial<FilterRule> & { pattern: string }): FilterRule {
  return { pattern: over.pattern, match: over.match ?? "glob", target: over.target ?? "both" };
}
const hit = (m: ReturnType<typeof matcher>, p: string, isDir = false) => m.match(p, isDir) !== null;

describe("glob anchoring", () => {
  it("floats an unanchored pattern at any depth", () => {
    const m = matcher([rule({ pattern: "*.tmp" })]);
    expect(hit(m, "a.tmp")).toBe(true);
    expect(hit(m, "x/y/a.tmp")).toBe(true);
    expect(hit(m, "a.txt")).toBe(false);
    expect(hit(m, "a.tmp.bak")).toBe(false);
  });

  it("anchors a leading-slash pattern to the root", () => {
    const m = matcher([rule({ pattern: "/build" })]);
    expect(hit(m, "build", true)).toBe(true);
    expect(hit(m, "x/build", true)).toBe(false);
  });

  it("anchors a pattern with an interior slash", () => {
    const m = matcher([rule({ pattern: "src/gen" })]);
    expect(hit(m, "src/gen", true)).toBe(true);
    expect(hit(m, "a/src/gen", true)).toBe(false);
  });

  it("spans segments with a globstar", () => {
    const m = matcher([rule({ pattern: "a/**/c" })]);
    expect(hit(m, "a/c")).toBe(true);
    expect(hit(m, "a/b/c")).toBe(true);
    expect(hit(m, "a/b/d/c")).toBe(true);
    expect(hit(m, "a/c/d")).toBe(false);
  });

  it("matches a whole directory subtree with a trailing globstar", () => {
    const m = matcher([rule({ pattern: "node_modules/**" })]);
    expect(hit(m, "node_modules/x.js")).toBe(true);
    expect(hit(m, "node_modules/a/b.js")).toBe(true);
    expect(hit(m, "src/node_modules")).toBe(false);
  });
});

describe("glob metacharacters", () => {
  it("honors a single-character wildcard", () => {
    const m = matcher([rule({ pattern: "log?.txt" })]);
    expect(hit(m, "log1.txt")).toBe(true);
    expect(hit(m, "log.txt")).toBe(false);
    expect(hit(m, "log12.txt")).toBe(false);
  });

  it("honors a character class", () => {
    const m = matcher([rule({ pattern: "v[0-9].bin" })]);
    expect(hit(m, "v3.bin")).toBe(true);
    expect(hit(m, "vx.bin")).toBe(false);
  });

  it("honors a brace alternation", () => {
    const m = matcher([rule({ pattern: "*.{jpg,png}" })]);
    expect(hit(m, "a.jpg")).toBe(true);
    expect(hit(m, "a.png")).toBe(true);
    expect(hit(m, "a.gif")).toBe(false);
  });

  it("matches a literal space in a name", () => {
    const m = matcher([rule({ pattern: "my file.txt" })]);
    expect(hit(m, "my file.txt")).toBe(true);
    expect(hit(m, "dir/my file.txt")).toBe(true);
  });
});

describe("dotfiles and case", () => {
  it("matches dotfiles (dot:true)", () => {
    const m = matcher([rule({ pattern: ".env" })]);
    expect(hit(m, ".env")).toBe(true);
    expect(hit(m, "cfg/.env")).toBe(true);
  });

  it("a star does not leak across a slash", () => {
    const m = matcher([rule({ pattern: "a/*" })]);
    expect(hit(m, "a/b")).toBe(true);
    expect(hit(m, "a/b/c")).toBe(false);
  });

  it("is case-sensitive", () => {
    const m = matcher([rule({ pattern: "*.TMP" })]);
    expect(hit(m, "a.TMP")).toBe(true);
    expect(hit(m, "a.tmp")).toBe(false);
  });
});

describe("regex and literal dialects", () => {
  it("matches a regex anywhere unless anchored", () => {
    const m = matcher([rule({ pattern: "\\.log$", match: "regex" })]);
    expect(hit(m, "a.log")).toBe(true);
    expect(hit(m, "deep/dir/a.log")).toBe(true);
    expect(hit(m, "a.log.txt")).toBe(false);
  });

  it("honors a fully anchored regex", () => {
    const m = matcher([rule({ pattern: "^cache/.*\\.bin$", match: "regex" })]);
    expect(hit(m, "cache/x.bin")).toBe(true);
    expect(hit(m, "app/cache/x.bin")).toBe(false);
  });

  it("matches a literal path exactly when anchored by an interior slash", () => {
    const m = matcher([rule({ pattern: "exact/name", match: "literal" })]);
    expect(hit(m, "exact/name")).toBe(true);
    expect(hit(m, "x/exact/name")).toBe(false);
  });

  it("matches an unanchored literal as a trailing component", () => {
    const m = matcher([rule({ pattern: "name", match: "literal" })]);
    expect(hit(m, "name")).toBe(true);
    expect(hit(m, "a/name")).toBe(true);
    expect(hit(m, "named")).toBe(false);
  });
});

describe("target applicability", () => {
  it("a directory-only rule ignores files", () => {
    const m = matcher([rule({ pattern: "node_modules", target: "dir" })]);
    expect(hit(m, "node_modules", true)).toBe(true);
    expect(hit(m, "node_modules", false)).toBe(false);
  });

  it("a file-only rule ignores directories", () => {
    const m = matcher([rule({ pattern: "build", target: "file" })]);
    expect(hit(m, "build", false)).toBe(true);
    expect(hit(m, "build", true)).toBe(false);
  });
});

describe("junk preset, ordering, and the inclusive default", () => {
  it("matches dotfile junk at any depth with the right rule id", () => {
    const m = matcher([], true);
    expect(m.match(".DS_Store", false)?.junkRule).toBe("macos.junk");
    expect(m.match("a/.DS_Store", false)?.junkRule).toBe("macos.junk");
    expect(m.match("Thumbs.db", false)?.junkRule).toBe("windows.junk");
  });

  it("matches junk case-insensitively (OS names vary in case across filesystems)", () => {
    const m = matcher([], true);
    expect(m.match("thumbs.db", false)?.junkRule).toBe("windows.junk");
    expect(m.match(".ds_store", false)?.junkRule).toBe("macos.junk");
    expect(m.match("DESKTOP.INI", false)?.junkRule).toBe("windows.junk");
    expect(m.match("dir/.DS_STORE", false)?.junkRule).toBe("macos.junk");
  });

  it("matches the added macOS metadata names", () => {
    const m = matcher([], true);
    for (const name of [
      ".DocumentRevisions-V100",
      ".TemporaryItems",
      ".apdisk",
      ".com.apple.timemachine.donotpresent",
      ".VolumeIcon.icns",
    ]) {
      expect(m.match(name, false)?.junkRule).toBe("macos.junk");
    }
  });

  it("matches Linux/freedesktop junk (.directory, .nfs* temporaries, .Trash-<uid>/)", () => {
    const m = matcher([], true);
    expect(m.match(".directory", false)?.junkRule).toBe("linux.junk");
    expect(m.match(".nfs0000000000abcdef00000001", false)?.junkRule).toBe("linux.junk");
    // `.Trash-<uid>` is a directory-only rule (trailing slash).
    expect(m.match(".Trash-1000", true)?.junkRule).toBe("linux.junk");
    expect(m.match(".Trash-1000", false)).toBeNull();
  });

  it("matches directory junk case-insensitively too", () => {
    const m = matcher([], true);
    expect(m.match("__macosx", true)?.junkRule).toBe("macos.junk");
    expect(m.match(".trash-1000", true)?.junkRule).toBe("linux.junk");
  });

  it("matches AppleDouble junk", () => {
    const m = matcher([], true);
    expect(m.match("._payload", false)?.junkRule).toBe("macos.junk");
    expect(m.match("dir/._payload", false)?.junkRule).toBe("macos.junk");
  });

  it("treats trailing-slash junk as directory-only", () => {
    const m = matcher([], true);
    expect(m.match("__MACOSX", true)?.junkRule).toBe("macos.junk");
    expect(m.match("__MACOSX", false)).toBeNull();
  });

  it("reports the first matching rule, user rules before junk", () => {
    const m = matcher([rule({ pattern: ".DS_Store" })], true);
    // A user rule and a junk rule both match; the user rule is reported.
    expect(m.match(".DS_Store", false)?.junkRule).toBeUndefined();
    expect(m.match(".DS_Store", false)?.describe).toContain("exclude rule");
  });

  it("keeps anything no rule matches (inclusive by default)", () => {
    const m = matcher([rule({ pattern: "*.tmp" })], true);
    expect(m.match("keep.txt", false)).toBeNull();
  });

  it("an empty rule set with no junk excludes nothing", () => {
    const m = matcher([], false);
    expect(m.match("anything/at/all.txt", false)).toBeNull();
  });
});

describe("rule builders (shared by create and extract)", () => {
  it("globExclude derives a directory target from a trailing slash", () => {
    expect(globExclude("logs/")).toEqual({ pattern: "logs/", match: "glob", target: "dir" });
    expect(globExclude("*.tmp")).toEqual({ pattern: "*.tmp", match: "glob", target: "both" });
  });
  it("regexExclude targets both files and directories", () => {
    expect(regexExclude("\\.log$")).toEqual({ pattern: "\\.log$", match: "regex", target: "both" });
  });
});
