/** Tests for the app's text-cleanup helper (text-cleanup-conventions). */

import { describe, expect, it } from "vitest";
import { multiline, singleLine } from "../../../src/gui/shared/textCleanup";

describe("singleLine", () => {
  it("trims the ends and flattens a pasted line break to one space", () => {
    expect(singleLine("  Iosevka,\r\n  monospace\u3000")).toBe("Iosevka, monospace");
  });

  it("keeps interior spacing typed within a line", () => {
    expect(singleLine("Iosevka  Term")).toBe("Iosevka  Term");
  });
});

describe("multiline", () => {
  it("normalizes CRLF and lone CR to LF", () => {
    expect(multiline("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("drops trailing whitespace on each line", () => {
    expect(multiline("a  \nb\t")).toBe("a\nb");
  });

  it("drops blank lines at the edges but keeps interior blank runs", () => {
    expect(multiline("\n\na\n\n\nb\n\n")).toBe("a\n\n\nb");
  });

  it("treats whitespace-only lines (spaces, full-width U+3000) as blank at the edges", () => {
    expect(multiline("  \n　\nx\n　")).toBe("x");
  });

  it("preserves indentation", () => {
    expect(multiline("  a\n    b")).toBe("  a\n    b");
  });

  it("collapses interior blank runs only when asked", () => {
    expect(multiline("a\n\n\nb", { collapseBlankLines: true })).toBe("a\n\nb");
  });

  it("can keep trailing whitespace for Markdown hard breaks when asked", () => {
    expect(multiline("a  \nb", { trimLineEnds: false })).toBe("a  \nb");
  });
});
