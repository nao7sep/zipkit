/**
 * Tests for the pure settings parse/serialize: a round-trip, missing fields
 * filled from the built-in defaults, and corrupt/foreign input degrading to the
 * defaults rather than throwing. The file I/O edge is not exercised here.
 */

import { describe, expect, it } from "vitest";
import { parseSettings, serializeSettings } from "../../../src/gui/main/settings";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec";

describe("settings", () => {
  it("round-trips the defaults", () => {
    const custom = { ...DEFAULT_OPTIONS, level: 9, strict: true, comment: "hi" };
    expect(parseSettings(serializeSettings(custom))).toEqual(custom);
  });

  it("fills missing option fields from the built-in defaults", () => {
    const parsed = parseSettings(JSON.stringify({ version: 1, defaults: { level: 1 } }));
    expect(parsed.level).toBe(1);
    expect(parsed.junk).toBe(DEFAULT_OPTIONS.junk);
    expect(parsed.symlinks).toBe(DEFAULT_OPTIONS.symlinks);
  });

  it("degrades to the defaults on invalid JSON", () => {
    expect(parseSettings("{ not json")).toEqual(DEFAULT_OPTIONS);
  });

  it("degrades to the defaults when 'defaults' is absent or not an object", () => {
    expect(parseSettings(JSON.stringify({ version: 1 }))).toEqual(DEFAULT_OPTIONS);
    expect(parseSettings(JSON.stringify({ defaults: null }))).toEqual(DEFAULT_OPTIONS);
    expect(parseSettings(JSON.stringify({ defaults: 5 }))).toEqual(DEFAULT_OPTIONS);
  });
});
