/**
 * Exclusion engine tests — exercised hard, because archive paths are full of
 * edge cases. Covers gitignore-flavoured glob anchoring, the `**` span, glob
 * metacharacters, the regex dialect, dotfiles, case sensitivity,
 * target applicability, the default list, ordering/reporting, and the inclusive
 * default.
 */

import { describe, expect, it } from "vitest";
import { buildMatcher } from "../../src/filter/match.ts";
import { DEFAULT_EXCLUSIONS } from "../../src/filter/defaults.ts";
import type { ExclusionPattern } from "../../src/types.ts";

/** The patterns given, then the default list when `defaults` is set, as a caller would list them. */
function matcher(rules: ExclusionPattern[], defaults = false) {
  return buildMatcher(defaults ? [...rules, ...DEFAULT_EXCLUSIONS] : rules);
}
function rule(over: Partial<ExclusionPattern> & { pattern: string }): ExclusionPattern {
  return { match: "glob", target: "both", ignoreCase: false, ...over };
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

describe("the regex dialect", () => {
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

describe("the default list, ordering, and the inclusive default", () => {
  it("matches dotfiles at any depth, noted with their OS", () => {
    const m = matcher([], true);
    expect(m.match(".DS_Store", false)?.pattern.note).toBe("macOS");
    expect(m.match("a/.DS_Store", false)?.pattern.note).toBe("macOS");
    expect(m.match("Thumbs.db", false)?.pattern.note).toBe("Windows");
    expect(m.match("ehthumbs_vista.db", false)?.pattern.note).toBe("Windows");
  });

  it("keeps files people sometimes want, which only look like leftovers", () => {
    const m = matcher([], true);
    for (const name of ["notes.txt~", "~$report.docx", "Shortcut.lnk", "Temporary Items", "Network Trash Folder"]) {
      expect(m.match(name, false)).toBeNull();
      expect(m.match(name, true)).toBeNull();
    }
  });

  it("matches the default list case-insensitively (OS names vary in case across file systems)", () => {
    const m = matcher([], true);
    expect(m.match("thumbs.db", false)?.pattern.note).toBe("Windows");
    expect(m.match(".ds_store", false)?.pattern.note).toBe("macOS");
    expect(m.match("DESKTOP.INI", false)?.pattern.note).toBe("Windows");
    expect(m.match("dir/.DS_STORE", false)?.pattern.note).toBe("macOS");
  });

  it("matches the added macOS metadata names", () => {
    const m = matcher([], true);
    for (const name of [
      ".DocumentRevisions-V100",
      ".TemporaryItems",
      ".apdisk",
      ".com.apple.timemachine.donotpresent",
      ".VolumeIcon.icns",
      ".localized",
      ".AppleDB",
      ".AppleDesktop",
    ]) {
      expect(m.match(name, false)?.pattern.note).toBe("macOS");
    }
  });

  it("matches Linux/freedesktop leftovers (.directory, .nfs* temporaries, .Trash-<uid>/)", () => {
    const m = matcher([], true);
    expect(m.match(".directory", false)?.pattern.note).toBe("Linux");
    expect(m.match(".nfs0000000000abcdef00000001", false)?.pattern.note).toBe("Linux");
    expect(m.match(".fuse_hidden0000000a00000001", false)?.pattern.note).toBe("Linux");
    // `.Trash-<uid>` is a directory-only rule (trailing slash).
    expect(m.match(".Trash-1000", true)?.pattern.note).toBe("Linux");
    expect(m.match(".Trash-1000", false)).toBeNull();
  });

  it("matches default folder patterns case-insensitively too", () => {
    const m = matcher([], true);
    expect(m.match("__macosx", true)?.pattern.note).toBe("macOS");
    expect(m.match(".trash-1000", true)?.pattern.note).toBe("Linux");
  });

  it("matches AppleDouble files", () => {
    const m = matcher([], true);
    expect(m.match("._payload", false)?.pattern.note).toBe("macOS");
    expect(m.match("dir/._payload", false)?.pattern.note).toBe("macOS");
  });

  it("treats a trailing-slash default as folder-only", () => {
    const m = matcher([], true);
    expect(m.match("__MACOSX", true)?.pattern.note).toBe("macOS");
    expect(m.match("__MACOSX", false)).toBeNull();
  });

  it("reports the first matching pattern in list order", () => {
    const m = matcher([rule({ pattern: ".DS_Store", note: "mine" })], true);
    expect(m.match(".DS_Store", false)?.pattern.note).toBe("mine");
    expect(m.match(".DS_Store", false)?.describe).toBe("pattern .DS_Store (mine)");
  });

  it("matches regardless of case only for a pattern that says so", () => {
    expect(matcher([rule({ pattern: "Build" })]).match("build", false)).toBeNull();
    expect(matcher([rule({ pattern: "Build", ignoreCase: true })]).match("build", false)).not.toBeNull();
    expect(matcher([rule({ pattern: "^Build$", match: "regex", ignoreCase: true })]).match("BUILD", false)).not.toBeNull();
  });

  it("keeps anything no rule matches (inclusive by default)", () => {
    const m = matcher([rule({ pattern: "*.tmp" })], true);
    expect(m.match("keep.txt", false)).toBeNull();
  });

  it("an empty list excludes nothing", () => {
    const m = matcher([], false);
    expect(m.match("anything/at/all.txt", false)).toBeNull();
  });
});
