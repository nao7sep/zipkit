/**
 * Tests for pane-layout parsing/serialization (the persisted side-column widths).
 * Pure functions only — the file I/O edge is the untested best-effort boundary,
 * matching settings.ts. Pins the clamp-and-default behavior so a stale or corrupt
 * file degrades to a usable layout rather than a broken one.
 */

import { describe, expect, it } from "vitest";
import { parseLayout, serializeLayout } from "../../../src/gui/main/layout.js";
import { DEFAULT_LAYOUT, LAYOUT_BOUNDS } from "../../../src/gui/shared/layout.js";

describe("parseLayout", () => {
  it("reads a stored layout", () => {
    const text = JSON.stringify({ version: 1, layout: { jobsWidth: 300, progressWidth: 360 } });
    expect(parseLayout(text)).toEqual({ jobsWidth: 300, progressWidth: 360 });
  });

  it("clamps out-of-bounds widths into the allowed range", () => {
    const text = JSON.stringify({ version: 1, layout: { jobsWidth: 10000, progressWidth: 1 } });
    expect(parseLayout(text)).toEqual({
      jobsWidth: LAYOUT_BOUNDS.jobsWidth.max,
      progressWidth: LAYOUT_BOUNDS.progressWidth.min,
    });
  });

  it("fills missing fields from the default layout", () => {
    const text = JSON.stringify({ version: 1, layout: { jobsWidth: 320 } });
    expect(parseLayout(text)).toEqual({
      jobsWidth: 320,
      progressWidth: DEFAULT_LAYOUT.progressWidth,
    });
  });

  it("falls back to the default layout on junk or a missing layout", () => {
    expect(parseLayout("not json")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(JSON.stringify({ version: 1 }))).toEqual(DEFAULT_LAYOUT);
  });
});

describe("serializeLayout", () => {
  it("round-trips through parseLayout", () => {
    const layout = { jobsWidth: 260, progressWidth: 420 };
    expect(parseLayout(serializeLayout(layout))).toEqual(layout);
  });

  it("clamps on write too, so a bad value can never be persisted", () => {
    const text = serializeLayout({ jobsWidth: -5, progressWidth: 99999 });
    expect(parseLayout(text)).toEqual({
      jobsWidth: LAYOUT_BOUNDS.jobsWidth.min,
      progressWidth: LAYOUT_BOUNDS.progressWidth.max,
    });
  });
});
