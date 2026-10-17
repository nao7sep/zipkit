/**
 * Path-level rooting table tests: absolute/drive-letter stripping,
 * `.`/`..` resolution and root-escape detection, backslash normalization, and
 * length limits. Tested directly because filesystem-scanned entries are already
 * clean relatives.
 */

import { describe, expect, it } from "vitest";
import { fixPath } from "../../../src/sdk/plan/pathFix.js";

describe("fixPath", () => {
  it("leaves a clean relative path untouched", () => {
    const r = fixPath("a/b/c.txt");
    expect(r).toMatchObject({ path: "a/b/c.txt", strippedAbsolute: false, escaped: false });
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(fixPath("a\\b\\c").path).toBe("a/b/c");
  });

  it("strips a leading slash and flags it absolute", () => {
    const r = fixPath("/etc/passwd");
    expect(r.path).toBe("etc/passwd");
    expect(r.strippedAbsolute).toBe(true);
  });

  it("strips a Windows drive prefix", () => {
    const r = fixPath("C:\\Users\\me\\file.txt");
    expect(r.path).toBe("Users/me/file.txt");
    expect(r.strippedAbsolute).toBe(true);
  });

  it("drops single-dot segments without flagging", () => {
    const r = fixPath("a/./b/./c");
    expect(r.path).toBe("a/b/c");
    expect(r.escaped).toBe(false);
  });

  it("resolves interior .. without escaping", () => {
    const r = fixPath("a/b/../c");
    expect(r.path).toBe("a/c");
    expect(r.escaped).toBe(false);
  });

  it("flags traversal that escapes the root", () => {
    expect(fixPath("../secret").escaped).toBe(true);
    expect(fixPath("a/../../secret").escaped).toBe(true);
  });

  it("flags an over-length component", () => {
    const r = fixPath(`${"x".repeat(300)}.txt`);
    expect(r.tooLongComponent).toBe(true);
  });

  it("flags an over-length full path", () => {
    const segments = Array.from({ length: 30 }, () => "abcdefghij").join("/");
    const r = fixPath(segments);
    expect(r.tooLongPath).toBe(true);
    expect(r.tooLongComponent).toBe(false);
  });
});
