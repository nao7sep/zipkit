/** Whole-set reads, sparse read-modify-writes, and managed-file recovery. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppLog } from "../../../src/gui/main/log.js";
import { storageRoot } from "../../../src/sdk/storage.js";
import { DEFAULT_OPTIONS, DEFAULT_SETTINGS } from "../../../src/gui/shared/spec";
import { managedEntries } from "../../helpers/managedEntries.js";

vi.mock("../../../src/gui/main/backupStore.js", () => ({ record: vi.fn() }));

let settings: typeof import("../../../src/gui/main/settings");
beforeEach(async () => {
  // Each test gets a fresh process-lifetime warning owner without a production
  // reset hook; repeated calls within a test share that owner.
  vi.resetModules();
  settings = await import("../../../src/gui/main/settings");
});

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

  it("warns once per key across parses, logger instances, and later malformed copies", () => {
    const firstLogger = warningLog();
    const laterLogger = warningLog();
    const invalid = JSON.stringify({ defaults: { level: 1 }, theme: "sepia" });
    expect(settings.parseSettings(invalid, firstLogger)).toEqual(DEFAULT_SETTINGS);
    expect(settings.parseSettings(invalid, firstLogger)).toEqual(DEFAULT_SETTINGS);
    expect(settings.parseSettings(settings.serializeSettings(CUSTOM), laterLogger)).toEqual(CUSTOM);
    expect(settings.parseSettings('{"defaults":null,"theme":42,"language":7}', laterLogger)).toEqual(DEFAULT_SETTINGS);
    expect(vi.mocked(firstLogger.warn).mock.calls.map((call) => call[1]?.key)).toEqual(["theme", "defaults"]);
    expect(laterLogger.warn).toHaveBeenCalledExactlyOnceWith(expect.any(String), { key: "language" });
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
    expect(await settings.saveSettings({ defaults })).toEqual({ ...DEFAULT_SETTINGS, defaults });
    expect(readStored()).toEqual({ defaults });
    expect((await settings.loadSettings()).value).toEqual({ ...DEFAULT_SETTINGS, defaults });
    expect(managedEntries(root)).toEqual(["config.json"]);
  });

  it("re-reads the current map and preserves untouched sets", async () => {
    await settings.saveSettings({ language: "ja" });
    writeFileSync(settings.settingsFile(), JSON.stringify({ language: "de", uiFontFamily: "Menlo" }));
    await settings.saveSettings({ theme: "dark" });
    expect(readStored()).toEqual({ language: "de", uiFontFamily: "Menlo", theme: "dark" });
  });

  it("serializes concurrent patches so both changed sets survive", async () => {
    await Promise.all([settings.saveSettings({ language: "ja" }), settings.saveSettings({ theme: "dark" })]);
    expect(readStored()).toEqual({ language: "ja", theme: "dark" });
  });

  it("drops version, unknown sets and unknown defaults members on the next write", async () => {
    writeFileSync(settings.settingsFile(), JSON.stringify({ version: 99, retired: true, defaults: { ...CUSTOM.defaults, unknown: "drop" } }));
    expect((await settings.loadSettings()).value.defaults).toEqual(CUSTOM.defaults);
    await settings.saveSettings({ theme: "light" });
    expect(readStored()).toEqual({ defaults: CUSTOM.defaults, theme: "light" });
  });

  it("a reset deletes defaults and keeps other stored sets", async () => {
    await settings.saveSettings(CUSTOM);
    expect(await settings.saveSettings({ defaults: null })).toEqual({ ...CUSTOM, defaults: DEFAULT_OPTIONS });
    expect(readStored()).toEqual({ uiFontFamily: CUSTOM.uiFontFamily, theme: CUSTOM.theme, language: CUSTOM.language });
  });

  it("a reset removes even a defaults copy identical to the built-in", async () => {
    await settings.saveSettings({ defaults: DEFAULT_OPTIONS });
    await settings.saveSettings({ defaults: null });
    expect(readStored()).toEqual({});
  });

  it("a malformed set remains in place and only falls back for that set", async () => {
    const bytes = JSON.stringify({ defaults: { level: 1 }, theme: "dark" });
    writeFileSync(settings.settingsFile(), bytes);
    const logger = warningLog();
    expect(await settings.loadSettings(logger)).toEqual({ value: { ...DEFAULT_SETTINGS, theme: "dark" }, missing: false, quarantinedTo: null });
    expect(readFileSync(settings.settingsFile(), "utf8")).toBe(bytes);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a set warning during repeated loads or the post-write parse", async () => {
    writeFileSync(settings.settingsFile(), '{"defaults":{"level":1}}');
    const logger = warningLog();
    expect((await settings.loadSettings(logger)).value).toEqual(DEFAULT_SETTINGS);
    expect((await settings.loadSettings(logger)).value).toEqual(DEFAULT_SETTINGS);
    expect(await settings.saveSettings({ theme: "dark" }, logger)).toEqual({ ...DEFAULT_SETTINGS, theme: "dark" });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.any(String), { key: "defaults" });
    expect(readStored()).toEqual({ defaults: { level: 1 }, theme: "dark" });
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
    await settings.saveSettings({ theme: "light" });
    expect(readStored()).toEqual({ theme: "light" });
    expect(readFileSync(loaded.quarantinedTo!, "utf8")).toBe(bytes);
  });
});
