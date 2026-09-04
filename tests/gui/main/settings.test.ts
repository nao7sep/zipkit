/**
 * Tests for the pure settings parse/serialize: a round-trip of the option defaults
 * plus the UI font, missing fields filled from the built-in defaults, and
 * corrupt/foreign input degrading to the defaults rather than throwing. The
 * filename-resolution and file-I/O edges are pinned in the last block below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureSettingsFile,
  loadSettings,
  parseSettings,
  saveSettings,
  serializeSettings,
  settingsFile,
} from "../../../src/gui/main/settings";
import type { AppLog } from "../../../src/gui/main/log.js";
import { storageRoot } from "../../../src/sdk/storage.js";
import { DEFAULT_OPTIONS, DEFAULT_SETTINGS } from "../../../src/gui/shared/spec";
import { managedEntries } from "../../helpers/managedEntries.js";

// This suite owns settings parsing and real filesystem persistence. The dedicated
// backupStore suite owns the real SQLite integration, so settings tests stop at
// the managed-write boundary rather than starting that worker for every case.
vi.mock("../../../src/gui/main/backupStore.js", () => ({ record: vi.fn() }));

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

  it("rejects a non-string UI font", () => {
    expect(() => parseSettings(JSON.stringify({ version: 1, defaults: {}, uiFontFamily: 42 }))).toThrow(/uiFontFamily/);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseSettings("{ not json")).toThrow(/invalid/);
  });

  it("fills an absent defaults object but rejects its wrong shape", () => {
    expect(parseSettings(JSON.stringify({ version: 1 }))).toEqual(DEFAULT_SETTINGS);
    expect(() => parseSettings(JSON.stringify({ version: 1, defaults: null }))).toThrow(/options/);
    expect(() => parseSettings(JSON.stringify({ version: 1, defaults: 5 }))).toThrow(/options/);
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

  it("creates config.json from defaults on first run", async () => {
    const file = path.join(root, "config.json");
    expect(() => readFileSync(file, "utf8")).toThrow();

    const created = await ensureSettingsFile();

    expect(created).toBe(true);
    // Written through saveSettings, so it round-trips and carries the schema version.
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
    expect((await loadSettings()).value).toEqual(DEFAULT_SETTINGS);
  });

  it("never overwrites an existing config.json", async () => {
    const custom = { defaults: { ...DEFAULT_OPTIONS, level: 9 }, uiFontFamily: "Iosevka" };
    await saveSettings(custom);
    const before = readFileSync(path.join(root, "config.json"), "utf8");

    const created = await ensureSettingsFile();

    expect(created).toBe(false);
    expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe(before);
    expect((await loadSettings()).value).toEqual(custom);
  });

  it("writes and reads back the settings as config.json, leaving no temp file", async () => {
    const settings = {
      defaults: { ...DEFAULT_OPTIONS, level: 9 },
      uiFontFamily: "Iosevka, monospace",
    };
    await saveSettings(settings);

    const file = path.join(root, "config.json");
    // The atomic write renames the temp (`config-<nanoid>.tmp`) over the target, so only the final
    // `config.json` remains (no orphaned temp, no dot-appended `config.json.tmp`, no legacy
    // `settings.json`).
    expect(managedEntries(root)).toEqual(["config.json"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
    expect((await loadSettings()).value).toEqual(settings);
  });

  it("quarantines a corrupt config.json aside (bytes intact) and returns the defaults", async () => {
    const file = path.join(root, "config.json");
    const corruptBytes = "{ not json";
    writeFileSync(file, corruptBytes, "utf8");
    const warnings: { message: string; fields?: Record<string, unknown> }[] = [];
    const logger: AppLog = {
      debug() {},
      info() {},
      warn: (message, fields) => warnings.push({ message, fields }),
      error() {},
    };

    const { value: settings, quarantinedTo } = await loadSettings(logger);

    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(file)).toBe(false); // moved aside, not left in place
    const entries = readdirSync(root);
    expect(entries).toHaveLength(1);
    const quarantined = entries[0]!;
    expect(quarantined).toMatch(/^config-\d{8}-\d{6}-\d{3}-utc\.invalid$/);
    expect(readFileSync(path.join(root, quarantined), "utf8")).toBe(corruptBytes);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields?.original).toBe(file);
    expect(warnings[0]?.fields?.quarantined).toBe(path.join(root, quarantined));
    expect(quarantinedTo).toBe(path.join(root, quarantined));
  });

  it("a save after quarantine writes a fresh config.json and never touches the quarantine file", async () => {
    const file = path.join(root, "config.json");
    writeFileSync(file, "{ not json", "utf8");
    await loadSettings();
    const quarantined = readdirSync(root).find((name) => name.endsWith(".invalid"))!;
    const before = readFileSync(path.join(root, quarantined), "utf8");

    await saveSettings({ defaults: { ...DEFAULT_OPTIONS, level: 3 }, uiFontFamily: "" });

    expect(readFileSync(path.join(root, quarantined), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
    expect(managedEntries(root).sort()).toEqual(["config.json", quarantined].sort());
  });

  it("quarantines a valid-JSON wrong shape but preserves a future-version file live", async () => {
    const file = path.join(root, "config.json");
    writeFileSync(file, JSON.stringify({ version: 1, defaults: { overwrite: "yes" } }));
    await expect(loadSettings()).resolves.toMatchObject({ value: DEFAULT_SETTINGS });
    expect(existsSync(file)).toBe(false);

    const future = JSON.stringify({ version: 99, defaults: {} });
    writeFileSync(file, future);
    await expect(loadSettings()).rejects.toThrow(/unsupported schema version 99/);
    expect(readFileSync(file, "utf8")).toBe(future);
  });
});
