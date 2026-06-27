/**
 * Tests for the pure settings parse/serialize: a round-trip of the option defaults
 * plus the UI font, missing fields filled from the built-in defaults, and
 * corrupt/foreign input degrading to the defaults rather than throwing. The file
 * I/O edge is not exercised here.
 */

import { describe, expect, it } from "vitest";
import { parseSettings, serializeSettings } from "../../../src/gui/main/settings";
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
