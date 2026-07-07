/**
 * Tests for the renderer's text-cleanup helper (the `multiline` pattern, used by
 * the archive comment). Pins the behaviors the convention specifies: newline
 * normalization, trailing-whitespace removal, edge-blank dropping with interior
 * runs kept, the trimmed-empty definition of "blank" (spaces and full-width
 * U+3000), indentation preservation, and opt-in interior collapse.
 */

import { describe, expect, it } from "vitest";
import { multiline } from "../../../src/gui/renderer/src/textCleanup";

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
