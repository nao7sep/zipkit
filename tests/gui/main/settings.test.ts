/** Whole-set reads, writes from the dialog's settings, and managed-file recovery. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppLog } from "../../../src/gui/main/log.js";
import { storageRoot } from "../../../src/sdk/storage.js";
import { DEFAULT_OPTIONS, DEFAULT_SETTINGS } from "../../../src/gui/shared/spec";
import { multiline, singleLine } from "../../../src/gui/shared/textCleanup";
import { managedEntries } from "../../helpers/managedEntries.js";

import * as settings from "../../../src/gui/main/settings";
import { record } from "../../../src/gui/main/backupStore.js";

vi.mock("../../../src/gui/main/backupStore.js", () => ({ record: vi.fn() }));

function warningLog() {
  const logger: AppLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return logger;
}

const CUSTOM = {
  defaults: { ...DEFAULT_OPTIONS, level: 9, strict: true, comment: "hi", fileName: "custom.zip" },
  uiFontFamily: "Iosevka, monospace",
  theme: "dark" as const,
  language: "pt-BR" as const,
};

describe("settings sets", () => {
  it("round-trips whole settings without config metadata", () => {
    expect(settings.parseSettings(settings.serializeSettings(CUSTOM))).toEqual(CUSTOM);
    expect(JSON.parse(settings.serializeSettings(CUSTOM))).toEqual(CUSTOM);
  });

  it("reads one set with every absent set using its built-in", () => {
    expect(settings.parseSettings('{"theme":"light"}')).toEqual({ ...DEFAULT_SETTINGS, theme: "light" });
    expect(settings.parseSettings('{}')).toEqual(DEFAULT_SETTINGS);
  });

  it.each([
    { level: 1 }, null, 5,
    { ...DEFAULT_OPTIONS, overwrite: "yes" },
    { ...DEFAULT_OPTIONS, level: 10 },
    { ...DEFAULT_OPTIONS, symlinks: "unknown" },
  ])("falls back for the entire invalid defaults set: %j", (defaults) => {
    const logger = warningLog();
    expect(settings.parseSettings(JSON.stringify({ defaults, theme: "dark" }), logger)).toEqual({ ...DEFAULT_SETTINGS, theme: "dark" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { key: "defaults" });
  });

  it("invalid scalar sets warn independently without affecting valid defaults", () => {
    const logger = warningLog();
    expect(settings.parseSettings(JSON.stringify({ defaults: CUSTOM.defaults, uiFontFamily: 42, theme: "sepia", language: "unknown" }), logger))
      .toEqual({ ...DEFAULT_SETTINGS, defaults: CUSTOM.defaults });
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(vi.mocked(logger.warn).mock.calls.map((call) => call[1]?.key).sort()).toEqual(["language", "theme", "uiFontFamily"]);
  });

  it("accepts any legacy version key as unknown", () => {
    expect(settings.parseSettings('{"version":99,"language":"ja"}')).toEqual({ ...DEFAULT_SETTINGS, language: "ja" });
  });

  it.each(["{ not json", "[]", "null", "5"])("rejects an unreadable document: %s", (text) => {
    expect(() => settings.parseSettings(text)).toThrow(/invalid/);
  });
});

describe("settings file location and persistence", () => {
  let root: string;
  const prev = process.env.ZIPKIT_DATA_DIR;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zipkit-home-"));
    process.env.ZIPKIT_DATA_DIR = root;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.ZIPKIT_DATA_DIR;
    else process.env.ZIPKIT_DATA_DIR = prev;
    await rm(root, { recursive: true, force: true });
  });

  const readStored = () => JSON.parse(readFileSync(settings.settingsFile(), "utf8"));

  it("resolves config.json separately from layout and queue", () => {
    expect(settings.settingsFile()).toBe(path.join(storageRoot(), "config.json"));
    expect(settings.settingsFile()).not.toBe(path.join(storageRoot(), "layout.json"));
    expect(settings.settingsFile()).not.toBe(path.join(storageRoot(), "queue.json"));
  });

  it("loads a fresh home without writing config.json", async () => {
    expect(await settings.loadSettings()).toEqual({ value: DEFAULT_SETTINGS, missing: true, quarantinedTo: null });
    expect(existsSync(settings.settingsFile())).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("changing one defaults member writes exactly the whole defaults set", async () => {
    const defaults = { ...DEFAULT_OPTIONS, level: 3 };
    expect(await settings.saveSettings({ ...DEFAULT_SETTINGS, defaults })).toEqual({ ...DEFAULT_SETTINGS, defaults });
    expect(readStored()).toEqual({ defaults });
    expect((await settings.loadSettings()).value).toEqual({ ...DEFAULT_SETTINGS, defaults });
    expect(managedEntries(root)).toEqual(["config.json"]);
  });

  it("a reset on a fresh data directory creates no file", async () => {
    expect(await settings.saveSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(readdirSync(root)).toEqual([]);
  });

  it("writes the file from the settings it is given, every set that differs", async () => {
    writeFileSync(settings.settingsFile(), JSON.stringify({ language: "de", uiFontFamily: "Menlo" }));
    await settings.saveSettings({ ...DEFAULT_SETTINGS, theme: "dark" });
    expect(readStored()).toEqual({ theme: "dark" });
  });

  it("drops version, unknown sets and unknown defaults members on the next write", async () => {
    writeFileSync(settings.settingsFile(), JSON.stringify({ version: 99, retired: true, defaults: { ...CUSTOM.defaults, unknown: "drop" } }));
    const loaded = (await settings.loadSettings()).value;
    expect(loaded.defaults).toEqual(CUSTOM.defaults);
    await settings.saveSettings({ ...loaded, theme: "light" });
    expect(readStored()).toEqual({ defaults: CUSTOM.defaults, theme: "light" });
  });

  it("a reset removes defaults and keeps other stored sets", async () => {
    await settings.saveSettings(CUSTOM);
    expect(await settings.saveSettings({ ...CUSTOM, defaults: DEFAULT_OPTIONS })).toEqual({ ...CUSTOM, defaults: DEFAULT_OPTIONS });
    expect(readStored()).toEqual({ uiFontFamily: CUSTOM.uiFontFamily, theme: CUSTOM.theme, language: CUSTOM.language });
  });

  it("removes a stored copy identical to the built-in and keeps the file as {}", async () => {
    writeFileSync(settings.settingsFile(), JSON.stringify({ defaults: DEFAULT_OPTIONS }));
    await settings.saveSettings(DEFAULT_SETTINGS);
    expect(readStored()).toEqual({});
  });

  it("writes nothing when the file would not change", async () => {
    vi.mocked(record).mockClear();
    await settings.saveSettings(CUSTOM);
    await settings.saveSettings(CUSTOM);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("compares and stores the font and the comment cleaned", async () => {
    const blank = { ...DEFAULT_SETTINGS, uiFontFamily: " \n ", defaults: { ...DEFAULT_OPTIONS, comment: "\n  \n" } };
    expect(await settings.saveSettings(blank)).toEqual(DEFAULT_SETTINGS);
    expect(readdirSync(root)).toEqual([]);
    const typed = { ...DEFAULT_SETTINGS, uiFontFamily: " Menlo\n", defaults: { ...DEFAULT_OPTIONS, comment: "\nhi  \n" } };
    await settings.saveSettings(typed);
    expect(readStored()).toEqual({ uiFontFamily: "Menlo", defaults: { ...DEFAULT_OPTIONS, comment: "hi" } });
  });

  it("keeps the built-in texts in cleaned form", () => {
    expect(singleLine(DEFAULT_SETTINGS.uiFontFamily)).toBe(DEFAULT_SETTINGS.uiFontFamily);
    expect(multiline(DEFAULT_OPTIONS.comment)).toBe(DEFAULT_OPTIONS.comment);
  });

  it("a malformed set remains in place and only falls back for that set", async () => {
    const bytes = JSON.stringify({ defaults: { level: 1 }, theme: "dark" });
    writeFileSync(settings.settingsFile(), bytes);
    const logger = warningLog();
    expect(await settings.loadSettings(logger)).toEqual({ value: { ...DEFAULT_SETTINGS, theme: "dark" }, missing: false, quarantinedTo: null });
    expect(readFileSync(settings.settingsFile(), "utf8")).toBe(bytes);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("a set that read as its built-in loses its key at the next save", async () => {
    writeFileSync(settings.settingsFile(), '{"defaults":{"level":1}}');
    const loaded = (await settings.loadSettings()).value;
    await settings.saveSettings({ ...loaded, theme: "dark" });
    expect(readStored()).toEqual({ theme: "dark" });
  });

  it.each(["{ not json", "[]"])("quarantines an unreadable file without replacing it: %s", async (bytes) => {
    const file = settings.settingsFile();
    writeFileSync(file, bytes);
    const logger = warningLog();
    const loaded = await settings.loadSettings(logger);
    expect(loaded.value).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(root)).toHaveLength(1);
    expect(loaded.quarantinedTo).toMatch(/config-\d{8}-\d{6}-\d{3}-utc\.invalid$/);
    expect(readFileSync(loaded.quarantinedTo!, "utf8")).toBe(bytes);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await settings.saveSettings({ ...loaded.value, theme: "light" });
    expect(readStored()).toEqual({ theme: "light" });
    expect(readFileSync(loaded.quarantinedTo!, "utf8")).toBe(bytes);
  });
});
