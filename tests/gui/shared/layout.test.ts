/**
 * Tests for the pure window/pane sizing in shared/layout.ts — the single source
 * of truth from which the window minimum is derived (window-chrome convention).
 * Pins four things: the derived-minimum invariant (the window min equals the
 * summed pane minimums + chrome, a literal guard so a magic number can't creep
 * back in), the width-aware clamp as the intent→display map (the center Archive
 * pane keeps its minimum across a width sweep and a drag stops before crossing
 * it), and the intent invariant (clamping for display is pure — it returns a new
 * layout and never mutates the stored intent it was given).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ARCHIVE_MIN_WIDTH,
  CONTROL_HEIGHT,
  RECORDS_DETAIL_MIN_WIDTH,
  RECORDS_FILTERS_GAP,
  RECORDS_FILTERS_HEIGHT,
  RECORDS_FILTERS_PADDING,
  RECORDS_LIST_MIN_HEIGHT,
  RECORDS_LIST_WIDTH,
  clampRecordsListWidth,
  recordsListDisplayWidth,
  recordsWindowMinHeight,
  recordsWindowMinWidth,
  BODY_PADDING,
  clampLayoutToWidth,
  DEFAULT_LAYOUT,
  HEADER_MIN_HEIGHT,
  LAYOUT_BOUNDS,
  minWindowHeight,
  minWindowWidth,
  SPLITTER_WIDTH,
  BODY_MIN_HEIGHT,
} from "../../../src/gui/shared/layout.js";

describe("derived window minimum", () => {
  it("minWindowWidth is exactly the summed pane minimums + splitters + body padding", () => {
    // Literal guard: this must equal the constants below, computed from them — not
    // a hand-typed window minimum. If a pane minimum changes, this updates with it.
    const expected =
      LAYOUT_BOUNDS.jobsWidth.min +
      ARCHIVE_MIN_WIDTH +
      LAYOUT_BOUNDS.progressWidth.min +
      2 * SPLITTER_WIDTH +
      2 * BODY_PADDING;
    expect(minWindowWidth()).toBe(expected);
    // And it genuinely reserves the center pane (regression guard for the bug
    // where a window min covered the side panes but not the binding pane).
    expect(minWindowWidth()).toBeGreaterThanOrEqual(
      LAYOUT_BOUNDS.jobsWidth.min + ARCHIVE_MIN_WIDTH + LAYOUT_BOUNDS.progressWidth.min,
    );
  });

  it("minWindowHeight is exactly header + body (the stacked fixed chrome)", () => {
    expect(minWindowHeight()).toBe(HEADER_MIN_HEIGHT + BODY_MIN_HEIGHT);
  });
});

describe("clampLayoutToWidth", () => {
  /** Width the center Archive pane gets for a given body width and side widths. */
  function archiveWidth(width: number, l: { jobsWidth: number; progressWidth: number }): number {
    return width - l.jobsWidth - l.progressWidth - 2 * SPLITTER_WIDTH - 2 * BODY_PADDING;
  }

  it("keeps the center pane at >= its minimum across a width sweep", () => {
    // Start from a layout that would overflow a narrow body if left unclamped.
    const greedy = { jobsWidth: LAYOUT_BOUNDS.jobsWidth.max, progressWidth: LAYOUT_BOUNDS.progressWidth.max };
    for (let width = minWindowWidth(); width <= minWindowWidth() + 1200; width += 37) {
      const out = clampLayoutToWidth(greedy, width);
      expect(archiveWidth(width, out)).toBeGreaterThanOrEqual(ARCHIVE_MIN_WIDTH);
      // Columns never drop below their own minimums.
      expect(out.jobsWidth).toBeGreaterThanOrEqual(LAYOUT_BOUNDS.jobsWidth.min);
      expect(out.progressWidth).toBeGreaterThanOrEqual(LAYOUT_BOUNDS.progressWidth.min);
    }
  });

  it("at exactly minWindowWidth, all three panes equal their minimums", () => {
    const out = clampLayoutToWidth(
      { jobsWidth: LAYOUT_BOUNDS.jobsWidth.max, progressWidth: LAYOUT_BOUNDS.progressWidth.max },
      minWindowWidth(),
    );
    expect(out.jobsWidth).toBe(LAYOUT_BOUNDS.jobsWidth.min);
    expect(out.progressWidth).toBe(LAYOUT_BOUNDS.progressWidth.min);
    expect(archiveWidth(minWindowWidth(), out)).toBe(ARCHIVE_MIN_WIDTH);
  });

  it("dragging Jobs wide stops before crossing the center minimum", () => {
    const width = minWindowWidth() + 100; // a little slack to share
    // Drag Jobs far past what fits.
    const out = clampLayoutToWidth({ ...DEFAULT_LAYOUT, jobsWidth: 5000 }, width);
    expect(archiveWidth(width, out)).toBeGreaterThanOrEqual(ARCHIVE_MIN_WIDTH);
    // The non-dragged side (Progress) yields first, down to its minimum.
    expect(out.progressWidth).toBe(LAYOUT_BOUNDS.progressWidth.min);
  });

  it("dragging Progress wide stops before crossing the center minimum", () => {
    const width = minWindowWidth() + 100;
    const out = clampLayoutToWidth({ ...DEFAULT_LAYOUT, progressWidth: 5000 }, width);
    expect(archiveWidth(width, out)).toBeGreaterThanOrEqual(ARCHIVE_MIN_WIDTH);
  });

  it("leaves a comfortably-fitting layout untouched", () => {
    const wide = minWindowWidth() + 600;
    const out = clampLayoutToWidth(DEFAULT_LAYOUT, wide);
    expect(out).toEqual(DEFAULT_LAYOUT);
  });

  it("floors to per-column minimums when the body is below the window minimum", () => {
    // Below the OS-enforced minimum (a transient measurement) it never returns a
    // sub-minimum or negative column.
    const out = clampLayoutToWidth(DEFAULT_LAYOUT, minWindowWidth() - 200);
    expect(out.jobsWidth).toBe(LAYOUT_BOUNDS.jobsWidth.min);
    expect(out.progressWidth).toBe(LAYOUT_BOUNDS.progressWidth.min);
  });

  it("falls back to the bounds clamp when the width is not finite", () => {
    const out = clampLayoutToWidth(DEFAULT_LAYOUT, Number.NaN);
    expect(out).toEqual(DEFAULT_LAYOUT);
  });

  it("maps intent to display without mutating the stored intent", () => {
    // The renderer keeps the user's drag widths as the persisted INTENT and feeds
    // the display grid clampLayoutToWidth(intent, containerWidth). That map must be
    // pure: clamping for a narrow window narrows what's shown but leaves the intent
    // object untouched, so re-growing the window returns the panes to the intent.
    const intent = { jobsWidth: LAYOUT_BOUNDS.jobsWidth.max, progressWidth: LAYOUT_BOUNDS.progressWidth.max };
    const snapshot = { ...intent };

    // Display on a too-narrow window: shown widths collapse toward the minimums…
    const small = clampLayoutToWidth(intent, minWindowWidth());
    expect(small.jobsWidth).toBe(LAYOUT_BOUNDS.jobsWidth.min);
    expect(small.progressWidth).toBe(LAYOUT_BOUNDS.progressWidth.min);
    expect(small).not.toBe(intent); // a fresh object, not the intent itself
    expect(intent).toEqual(snapshot); // …but the intent is unchanged

    // …and a wide-enough window shows the full intent again.
    const wide = clampLayoutToWidth(intent, minWindowWidth() + 1000);
    expect(wide).toEqual(snapshot);
    expect(intent).toEqual(snapshot);
  });
});

describe("the Records window's layout", () => {
  it("derives its minimum from both panes, the handle, their borders and the body padding", () => {
    expect(recordsWindowMinWidth()).toBe(
      2 * BODY_PADDING + RECORDS_LIST_WIDTH.min + SPLITTER_WIDTH + RECORDS_DETAIL_MIN_WIDTH + 2 * 2,
    );
    expect(recordsWindowMinHeight()).toBe(2 * BODY_PADDING + 2 + RECORDS_FILTERS_HEIGHT + RECORDS_LIST_MIN_HEIGHT);
  });

  it("sizes the filter band from the app's one control height, as index.css sets it", () => {
    const css = readFileSync(resolve("src/gui/renderer/src/index.css"), "utf8");
    expect(css).toMatch(new RegExp(`--control-h:\\s*${CONTROL_HEIGHT}px;`));
    expect(RECORDS_FILTERS_HEIGHT).toBe(2 * RECORDS_FILTERS_PADDING + 3 * CONTROL_HEIGHT + 2 * RECORDS_FILTERS_GAP + 1);
  });

  it("stores the dragged list width inside its bounds, opening at the default", () => {
    expect(RECORDS_LIST_WIDTH).toEqual({ min: 320, default: 380, max: 640 });
    expect(clampRecordsListWidth(10)).toBe(RECORDS_LIST_WIDTH.min);
    expect(clampRecordsListWidth(5000)).toBe(RECORDS_LIST_WIDTH.max);
    expect(clampRecordsListWidth(450.4)).toBe(450);
  });

  it("narrows only what is shown as the window narrows, keeping the detail pane at its minimum", () => {
    const wide = recordsWindowMinWidth() + 1000;
    expect(recordsListDisplayWidth(600, wide)).toBe(600);
    // At the window minimum the list shows its own minimum, whatever the intent.
    expect(recordsListDisplayWidth(600, recordsWindowMinWidth())).toBe(RECORDS_LIST_WIDTH.min);
    expect(recordsListDisplayWidth(600, recordsWindowMinWidth() + 100)).toBe(RECORDS_LIST_WIDTH.min + 100);
    // Before the shell is measured, the intent shows as it is.
    expect(recordsListDisplayWidth(600, 0)).toBe(600);
  });
});
