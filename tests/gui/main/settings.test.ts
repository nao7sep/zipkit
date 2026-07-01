/**
 * Tests for the pure settings parse/serialize: a round-trip of the option defaults
 * plus the UI font, missing fields filled from the built-in defaults, and
 * corrupt/foreign input degrading to the defaults rather than throwing. The
 * filename-resolution and file-I/O edges are pinned in the last block below.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadSettings,
  parseSettings,
  saveSettings,
  serializeSettings,
  settingsFile,
} from "../../../src/gui/main/settings";
import { storageRoot } from "../../../src/sdk/storage.js";
import { DEFAULT_OPTIONS, DEFAULT_SETTINGS } from "../../../src/gui/shared/spec";

describe("settings", () => {
  it("round-trips the settings (option defaults + UI font)", () => {
    const custom = {
      defaults: { ...DEFAULT_OPTIONS, level: 9, strict: true, comment: "hi" },
      uiFontFamily: "Iosevka, monospace",
    };
    expect(parseSettings(serializeSettings(custom))).toEqual(custom);
  });

  it("fills missing option fields from the built-in defaults", () => {
    const parsed = parseSettings(JSON.stringify({ version: 1, defaults: { level: 1 } }));
    expect(parsed.defaults.level).toBe(1);
    expect(parsed.defaults.junk).toBe(DEFAULT_OPTIONS.junk);
    expect(parsed.defaults.symlinks).toBe(DEFAULT_OPTIONS.symlinks);
  });

  it("defaults the UI font to blank, backfilling a file written before it existed", () => {
    const parsed = parseSettings(JSON.stringify({ version: 1, defaults: { level: 1 } }));
    expect(parsed.uiFontFamily).toBe("");
  });

  it("ignores a non-string UI font", () => {
    const parsed = parseSettings(JSON.stringify({ version: 1, defaults: {}, uiFontFamily: 42 }));
    expect(parsed.uiFontFamily).toBe("");
  });

  it("degrades to the defaults on invalid JSON", () => {
    expect(parseSettings("{ not json")).toEqual(DEFAULT_SETTINGS);
  });

  it("degrades to the defaults when 'defaults' is absent or not an object", () => {
    expect(parseSettings(JSON.stringify({ version: 1 }))).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(JSON.stringify({ defaults: null }))).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(JSON.stringify({ defaults: 5 }))).toEqual(DEFAULT_SETTINGS);
  });
});

describe("settings file location and persistence", () => {
  // The durable settings live at `config.json` under the resolved storage root,
  // beside — and distinct from — `layout.json` and `queue.json`. Relocating the
  // root via ZIPKIT_HOME to a throwaway directory keeps the suite out of the real
  // home dir and pins the resolved filename + atomic round-trip in one place.
  let root: string;
  const prev = process.env.ZIPKIT_HOME;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zipkit-home-"));
    process.env.ZIPKIT_HOME = root;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.ZIPKIT_HOME;
    else process.env.ZIPKIT_HOME = prev;
    await rm(root, { recursive: true, force: true });
  });

  it("resolves the durable settings to config.json under the storage root", () => {
    expect(settingsFile()).toBe(path.join(storageRoot(), "config.json"));
    expect(path.basename(settingsFile())).toBe("config.json");
  });

  it("stays a separate file from the layout and queue stores", () => {
    // layout.json and queue.json are distinct roles under the same root; the
    // settings file must never collide with either.
    const layout = path.join(storageRoot(), "layout.json");
    const queue = path.join(storageRoot(), "queue.json");
    expect(settingsFile()).not.toBe(layout);
    expect(settingsFile()).not.toBe(queue);
    expect(path.basename(settingsFile())).not.toBe("settings.json");
  });

  it("writes and reads back the settings as config.json, leaving no temp file", async () => {
    const settings = {
      defaults: { ...DEFAULT_OPTIONS, level: 9 },
      uiFontFamily: "Iosevka, monospace",
    };
    await saveSettings(settings);

    const file = path.join(root, "config.json");
    // The atomic write renames the temp over the target, so only the final
    // `config.json` remains (no orphaned `.tmp`, no legacy `settings.json`).
    expect(() => readFileSync(`${file}.tmp`, "utf8")).toThrow();
    expect(() => readFileSync(path.join(root, "settings.json"), "utf8")).toThrow();
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
    expect(await loadSettings()).toEqual(settings);
  });
});
