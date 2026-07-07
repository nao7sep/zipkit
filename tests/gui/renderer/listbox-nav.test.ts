/**
 * Tests for the listbox keyboard model (pure index math). These pin the
 * composite-control behaviors: stop-at-ends arrow/Home/End/Page navigation,
 * stop-at-end (non-wrapping) type-ahead by label, and next->previous->empty
 * recovery on removal.
 */

import { describe, expect, it } from "vitest";
import { navIndex, recoverIndex, typeaheadIndex } from "../../../src/gui/renderer/src/listbox-nav";

describe("navIndex", () => {
  it("moves down and up, stopping at the ends", () => {
    expect(navIndex(0, 3, "ArrowDown")).toBe(1);
    expect(navIndex(2, 3, "ArrowDown")).toBe(2); // stop at bottom
    expect(navIndex(2, 3, "ArrowUp")).toBe(1);
    expect(navIndex(0, 3, "ArrowUp")).toBe(0); // stop at top
  });

  it("jumps to the ends with Home/End", () => {
    expect(navIndex(1, 3, "Home")).toBe(0);
    expect(navIndex(1, 3, "End")).toBe(2);
  });

  it("pages by a page size, clamped", () => {
    expect(navIndex(0, 100, "PageDown", 10)).toBe(10);
    expect(navIndex(5, 100, "PageUp", 10)).toBe(0);
  });

  it("lands on the first item from no selection", () => {
    expect(navIndex(-1, 3, "ArrowDown")).toBe(0);
    expect(navIndex(-1, 3, "ArrowUp")).toBe(0);
  });

  it("returns null for non-nav keys and an empty list", () => {
    expect(navIndex(0, 3, "a")).toBeNull();
    expect(navIndex(0, 0, "ArrowDown")).toBeNull();
  });
});

describe("typeaheadIndex", () => {
  const labels = ["alpha", "beta", "gamma", "beta-2"];

  it("jumps to the next matching label ahead, stopping at the end (no wrap)", () => {
    expect(typeaheadIndex(labels, 0, "b")).toBe(1);
    expect(typeaheadIndex(labels, 1, "b")).toBe(3); // next "b" after index 1
    expect(typeaheadIndex(labels, 3, "b")).toBeNull(); // no match ahead -> stop, no wrap
  });

  it("matches from the first item when nothing is selected", () => {
    expect(typeaheadIndex(labels, -1, "b")).toBe(1);
  });

  it("is case-insensitive and matches multi-character queries", () => {
    expect(typeaheadIndex(labels, 0, "GAM")).toBe(2);
  });

  it("returns null when nothing matches ahead or the query is empty", () => {
    expect(typeaheadIndex(labels, 0, "z")).toBeNull();
    expect(typeaheadIndex(labels, 0, "")).toBeNull();
  });
});

describe("recoverIndex", () => {
  it("selects next, then previous, then empty", () => {
    expect(recoverIndex(1, 4)).toBe(1); // remove a middle item -> next slides in
    expect(recoverIndex(3, 4)).toBe(2); // remove the last -> previous
    expect(recoverIndex(0, 1)).toBeNull(); // remove the only item -> empty
  });
});
