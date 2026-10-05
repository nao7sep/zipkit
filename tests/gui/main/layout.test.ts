/**
 * Tests for pane-layout parsing/serialization (the persisted side-column widths).
 * Pure functions only — the file I/O edge is the untested best-effort boundary,
 * matching settings.ts. Pins the clamp-and-default behavior so a stale or corrupt
 * file degrades to a usable layout rather than a broken one.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadLayout,
  parseLayout,
  recordsListWidth,
  saveLayout,
  saveRecordsListWidth,
  serializeLayout,
} from "../../../src/gui/main/layout.js";
import type { AppLog } from "../../../src/gui/main/log.js";
import {
  ARCHIVE_MIN_WIDTH,
  BODY_PADDING,
  clampLayoutToWidth,
  DEFAULT_LAYOUT,
  LAYOUT_BOUNDS,
  minWindowWidth,
  RECORDS_LIST_WIDTH,
  SPLITTER_WIDTH,
} from "../../../src/gui/shared/layout.js";
import { closeBackupStore } from "../../../src/gui/main/backupStore.js";
import { managedEntries } from "../../helpers/managedEntries.js";
import { FORMAT_VERSIONS, NewerFormatError } from "../../../src/gui/main/formatVersions.js";

// The default layout as the file holds it: the main window's panes and the
// Records window's list pane.
const DEFAULT_STORED = { ...DEFAULT_LAYOUT, recordsListWidth: RECORDS_LIST_WIDTH.default };

describe("parseLayout", () => {
  it("reads a stored layout", () => {
    const root = { formatVersion: 1, layout: { jobsWidth: 300, progressWidth: 360, recordsListWidth: 500 } };
    expect(parseLayout(root)).toEqual({ jobsWidth: 300, progressWidth: 360, recordsListWidth: 500 });
  });

  it("clamps out-of-bounds widths into the allowed range", () => {
    const root = { formatVersion: 1, layout: { jobsWidth: 10000, progressWidth: 1, recordsListWidth: 1 } };
    expect(parseLayout(root)).toEqual({
      jobsWidth: LAYOUT_BOUNDS.jobsWidth.max,
      progressWidth: LAYOUT_BOUNDS.progressWidth.min,
      recordsListWidth: RECORDS_LIST_WIDTH.min,
    });
  });

  it("fills missing fields from the default layout, the Records list width included", () => {
    const root = { formatVersion: 1, layout: { jobsWidth: 320 } };
    expect(parseLayout(root)).toEqual({ ...DEFAULT_STORED, jobsWidth: 320 });
  });

  it("rejects a missing layout so the loader can preserve it", () => {
    expect(() => parseLayout({ formatVersion: 1 })).toThrow(/layout/);
  });
});

describe("persisted bounds feed the derived window minimum", () => {
  it("the window minimum is derived from the same column minimums the store clamps to", () => {
    // The persisted-layout clamp (parseLayout) and the OS window minimum must use
    // ONE source of truth for the column minimums, so the window can never be sized
    // below what a persisted layout can hold. This ties the two together.
    expect(minWindowWidth()).toBe(
      LAYOUT_BOUNDS.jobsWidth.min +
        ARCHIVE_MIN_WIDTH +
        LAYOUT_BOUNDS.progressWidth.min +
        2 * SPLITTER_WIDTH +
        2 * BODY_PADDING,
    );
    // A persisted layout clamped to its minimum side widths still fits the center
    // pane at the window minimum (no persisted state can violate the invariant).
    const minSides = parseLayout({ formatVersion: 1, layout: { jobsWidth: 0, progressWidth: 0 } });
    const centerAtMin =
      minWindowWidth() - minSides.jobsWidth - minSides.progressWidth - 2 * SPLITTER_WIDTH - 2 * BODY_PADDING;
    expect(centerAtMin).toBe(ARCHIVE_MIN_WIDTH);
  });
});

describe("serializeLayout", () => {
  it("round-trips through parseLayout", () => {
    const layout = { jobsWidth: 260, progressWidth: 420, recordsListWidth: 450 };
    const serialized = serializeLayout(layout);
    expect(parseLayout(JSON.parse(serialized))).toEqual(layout);
    expect(JSON.parse(serialized)).toEqual({ formatVersion: FORMAT_VERSIONS.layout, layout });
  });

  it("clamps on write too, so a bad value can never be persisted", () => {
    const text = serializeLayout({ jobsWidth: -5, progressWidth: 99999, recordsListWidth: 99999 });
    expect(parseLayout(JSON.parse(text))).toEqual({
      jobsWidth: LAYOUT_BOUNDS.jobsWidth.min,
      progressWidth: LAYOUT_BOUNDS.progressWidth.max,
      recordsListWidth: RECORDS_LIST_WIDTH.max,
    });
  });
});

describe("persists the intent, not the resize-clamped display", () => {
  it("stores the user's drag widths verbatim, even when a narrow window would clamp the display", () => {
    // The renderer persists the INTENT (the dragged widths) and only ever clamps
    // for DISPLAY against the live body width. So a wide intent saved on a big
    // window must survive in the file as-is — NOT collapsed to what a later, smaller
    // window would show. This pins that the persistence boundary stores the intent.
    const intent = { ...DEFAULT_STORED, jobsWidth: LAYOUT_BOUNDS.jobsWidth.max, progressWidth: LAYOUT_BOUNDS.progressWidth.max };

    // What a shrunk window would DISPLAY (the clamped widths) — must NOT be persisted.
    const clampedForDisplay = clampLayoutToWidth(intent, minWindowWidth());
    expect(clampedForDisplay).not.toEqual(intent); // the display really is narrowed

    // Persisting the intent (drag value) and reading it back yields the intent,
    // never the resize-clamped display.
    const restored = parseLayout(JSON.parse(serializeLayout(intent)));
    expect(restored).toEqual(intent);
    expect(restored).not.toEqual(clampedForDisplay);

    // And reopening on a small window re-derives the same narrowed display from the
    // preserved intent — maximizing later returns to the full intent.
    expect(clampLayoutToWidth(restored, minWindowWidth())).toEqual(clampedForDisplay);
  });
});

describe("layout file quarantine-then-reset", () => {
  // Relocating the root via ZIPKIT_DATA_DIR to a throwaway directory keeps the suite out of the real
  // home dir, matching settings.test.ts's and persist.test.ts's file-I/O sections.
  let root: string;
  const prev = process.env.ZIPKIT_DATA_DIR;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zipkit-home-"));
    process.env.ZIPKIT_DATA_DIR = root;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.ZIPKIT_DATA_DIR;
    else process.env.ZIPKIT_DATA_DIR = prev;
    // Close the backup store so a test that opened it against this throwaway root releases it before
    // the rm below (saveLayout itself no longer records).
    await closeBackupStore();
    await rm(root, { recursive: true, force: true });
  });

  it("quarantines a corrupt layout.json aside (bytes intact) and returns the default layout", async () => {
    const file = path.join(root, "layout.json");
    const corruptBytes = "not json";
    writeFileSync(file, corruptBytes, "utf8");
    const warnings: { message: string; fields?: Record<string, unknown> }[] = [];
    const logger: AppLog = {
      debug() {},
      info() {},
      warn: (message, fields) => warnings.push({ message, fields }),
      error() {},
    };

    const { value: layout, quarantinedTo } = await loadLayout(logger);

    expect(layout).toEqual(DEFAULT_STORED);
    expect(existsSync(file)).toBe(false); // moved aside, not left in place
    const entries = readdirSync(root);
    expect(entries).toHaveLength(1);
    const quarantined = entries[0]!;
    expect(quarantined).toMatch(/^layout-\d{8}-\d{6}-\d{3}-utc\.invalid$/);
    expect(readFileSync(path.join(root, quarantined), "utf8")).toBe(corruptBytes);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields?.original).toBe(file);
    expect(warnings[0]?.fields?.quarantined).toBe(path.join(root, quarantined));
    expect(quarantinedTo).toBe(path.join(root, quarantined));
  });

  it("a save after quarantine writes a fresh layout.json and never touches the quarantine file", async () => {
    const file = path.join(root, "layout.json");
    writeFileSync(file, "not json", "utf8");
    await loadLayout();
    const quarantined = readdirSync(root).find((name) => name.endsWith(".invalid"))!;
    const before = readFileSync(path.join(root, quarantined), "utf8");

    await saveLayout({ jobsWidth: 300, progressWidth: 360 });

    expect(readFileSync(path.join(root, quarantined), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ formatVersion: 1 });
    expect(managedEntries(root).sort()).toEqual(["layout.json", quarantined].sort());
    expect(existsSync(path.join(root, "backups.sqlite3"))).toBe(false); // layout is volatile state: not recorded
  });

  it("quarantines wrong-shaped widths instead of silently rewriting them", async () => {
    const file = path.join(root, "layout.json");
    writeFileSync(file, JSON.stringify({ formatVersion: 1, layout: { jobsWidth: "wide" } }));
    const loaded = await loadLayout();
    expect(loaded.value).toEqual(DEFAULT_STORED);
    expect(loaded.quarantinedTo).toMatch(/\.invalid$/);
    expect(existsSync(file)).toBe(false);
  });

  it("quarantines a wrong-shaped Records list width too", async () => {
    const file = path.join(root, "layout.json");
    writeFileSync(file, JSON.stringify({ formatVersion: 1, layout: { recordsListWidth: "wide" } }));
    const loaded = await loadLayout();
    expect(loaded.value).toEqual(DEFAULT_STORED);
    expect(loaded.quarantinedTo).toMatch(/\.invalid$/);
  });

  it("restores the Records list width saved before, and each window's save keeps the other's widths", async () => {
    const file = path.join(root, "layout.json");
    writeFileSync(file, serializeLayout({ jobsWidth: 300, progressWidth: 360, recordsListWidth: 500 }));
    await loadLayout();
    expect(recordsListWidth()).toBe(500);

    expect(await saveRecordsListWidth(9999)).toBe(RECORDS_LIST_WIDTH.max);
    expect(parseLayout(JSON.parse(readFileSync(file, "utf8")))).toEqual({ jobsWidth: 300, progressWidth: 360, recordsListWidth: RECORDS_LIST_WIDTH.max });

    await saveLayout({ jobsWidth: 320, progressWidth: 380 });
    expect(parseLayout(JSON.parse(readFileSync(file, "utf8")))).toEqual({ jobsWidth: 320, progressWidth: 380, recordsListWidth: RECORDS_LIST_WIDTH.max });
    expect(recordsListWidth()).toBe(RECORDS_LIST_WIDTH.max);
  });

  it("writes overlapping saves in the order they were made", async () => {
    const file = path.join(root, "layout.json");
    await loadLayout();
    await Promise.all([
      saveRecordsListWidth(400),
      saveLayout({ jobsWidth: 250, progressWidth: 300 }),
      saveRecordsListWidth(420),
    ]);
    expect(parseLayout(JSON.parse(readFileSync(file, "utf8")))).toEqual({ jobsWidth: 250, progressWidth: 300, recordsListWidth: 420 });
  });

  it("reads a layout without a format version as format 1", async () => {
    writeFileSync(path.join(root, "layout.json"), JSON.stringify({ layout: { jobsWidth: 300 } }));
    const loaded = await loadLayout();
    expect(loaded).toEqual({ value: { ...DEFAULT_STORED, jobsWidth: 300 }, quarantinedTo: null, missing: false });
  });

  it("leaves a layout a newer build wrote exactly in place and reports it by path", async () => {
    const file = path.join(root, "layout.json");
    const bytes = JSON.stringify({ formatVersion: FORMAT_VERSIONS.layout + 1, layout: {} });
    writeFileSync(file, bytes);
    const failure = await loadLayout().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(NewerFormatError);
    expect(failure).toMatchObject({ file, found: FORMAT_VERSIONS.layout + 1, supported: FORMAT_VERSIONS.layout });
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(managedEntries(root)).toEqual(["layout.json"]);
  });
});
