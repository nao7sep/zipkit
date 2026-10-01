/** Whole-set reads, sparse read-modify-writes, and managed-file recovery. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSettings, parseSettings, saveSettings, serializeSettings, settingsFile } from "../../../src/gui/main/settings";
import type { AppLog } from "../../../src/gui/main/log.js";
import { storageRoot } from "../../../src/sdk/storage.js";
import { DEFAULT_OPTIONS, DEFAULT_SETTINGS } from "../../../src/gui/shared/spec";
import { managedEntries } from "../../helpers/managedEntries.js";

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
    expect(parseSettings(serializeSettings(CUSTOM))).toEqual(CUSTOM);
    expect(JSON.parse(serializeSettings(CUSTOM))).toEqual(CUSTOM);
  });

  it("reads one set with every absent set using its built-in", () => {
    expect(parseSettings('{"theme":"light"}')).toEqual({ ...DEFAULT_SETTINGS, theme: "light" });
    expect(parseSettings('{}')).toEqual(DEFAULT_SETTINGS);
  });

  it.each([
    { level: 1 }, null, 5,
    { ...DEFAULT_OPTIONS, overwrite: "yes" },
    { ...DEFAULT_OPTIONS, level: 10 },
    { ...DEFAULT_OPTIONS, symlinks: "unknown" },
  ])("falls back for the entire invalid defaults set: %j", (defaults) => {
    const logger = warningLog();
    expect(parseSettings(JSON.stringify({ defaults, theme: "dark" }), logger)).toEqual({ ...DEFAULT_SETTINGS, theme: "dark" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { key: "defaults" });
  });

  it("invalid scalar sets warn independently without affecting valid defaults", () => {
    const logger = warningLog();
    expect(parseSettings(JSON.stringify({ defaults: CUSTOM.defaults, uiFontFamily: 42, theme: "sepia", language: "unknown" }), logger))
      .toEqual({ ...DEFAULT_SETTINGS, defaults: CUSTOM.defaults });
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(vi.mocked(logger.warn).mock.calls.map((call) => call[1]?.key).sort()).toEqual(["language", "theme", "uiFontFamily"]);
  });

  it("accepts any legacy version key as unknown", () => {
    expect(parseSettings('{"version":99,"language":"ja"}')).toEqual({ ...DEFAULT_SETTINGS, language: "ja" });
  });

  it.each(["{ not json", "[]", "null", "5"])("rejects an unreadable document: %s", (text) => {
    expect(() => parseSettings(text)).toThrow(/invalid/);
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

  const readStored = () => JSON.parse(readFileSync(settingsFile(), "utf8"));

  it("resolves config.json separately from layout and queue", () => {
    expect(settingsFile()).toBe(path.join(storageRoot(), "config.json"));
    expect(settingsFile()).not.toBe(path.join(storageRoot(), "layout.json"));
    expect(settingsFile()).not.toBe(path.join(storageRoot(), "queue.json"));
  });

  it("loads a fresh home without writing config.json", async () => {
    expect(await loadSettings()).toEqual({ value: DEFAULT_SETTINGS, missing: true, quarantinedTo: null });
    expect(existsSync(settingsFile())).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("changing one defaults member writes exactly the whole defaults set", async () => {
    const defaults = { ...DEFAULT_OPTIONS, level: 3 };
    expect(await saveSettings({ defaults })).toEqual({ ...DEFAULT_SETTINGS, defaults });
    expect(readStored()).toEqual({ defaults });
    expect((await loadSettings()).value).toEqual({ ...DEFAULT_SETTINGS, defaults });
    expect(managedEntries(root)).toEqual(["config.json"]);
  });

  it("re-reads the current map and preserves untouched sets", async () => {
    await saveSettings({ language: "ja" });
    writeFileSync(settingsFile(), JSON.stringify({ language: "de", uiFontFamily: "Menlo" }));
    await saveSettings({ theme: "dark" });
    expect(readStored()).toEqual({ language: "de", uiFontFamily: "Menlo", theme: "dark" });
  });

  it("serializes concurrent patches so both changed sets survive", async () => {
    await Promise.all([saveSettings({ language: "ja" }), saveSettings({ theme: "dark" })]);
    expect(readStored()).toEqual({ language: "ja", theme: "dark" });
  });

  it("drops version, unknown sets and unknown defaults members on the next write", async () => {
    writeFileSync(settingsFile(), JSON.stringify({ version: 99, retired: true, defaults: { ...CUSTOM.defaults, unknown: "drop" } }));
    expect((await loadSettings()).value.defaults).toEqual(CUSTOM.defaults);
    await saveSettings({ theme: "light" });
    expect(readStored()).toEqual({ defaults: CUSTOM.defaults, theme: "light" });
  });

  it("a reset deletes defaults and keeps other stored sets", async () => {
    await saveSettings(CUSTOM);
    expect(await saveSettings({ defaults: null })).toEqual({ ...CUSTOM, defaults: DEFAULT_OPTIONS });
    expect(readStored()).toEqual({ uiFontFamily: CUSTOM.uiFontFamily, theme: CUSTOM.theme, language: CUSTOM.language });
  });

  it("a reset removes even a defaults copy identical to the built-in", async () => {
    await saveSettings({ defaults: DEFAULT_OPTIONS });
    await saveSettings({ defaults: null });
    expect(readStored()).toEqual({});
  });

  it("a malformed set remains in place and only falls back for that set", async () => {
    const bytes = JSON.stringify({ defaults: { level: 1 }, theme: "dark" });
    writeFileSync(settingsFile(), bytes);
    const logger = warningLog();
    expect(await loadSettings(logger)).toEqual({ value: { ...DEFAULT_SETTINGS, theme: "dark" }, missing: false, quarantinedTo: null });
    expect(readFileSync(settingsFile(), "utf8")).toBe(bytes);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it.each(["{ not json", "[]"])("quarantines an unreadable file without replacing it: %s", async (bytes) => {
    const file = settingsFile();
    writeFileSync(file, bytes);
    const logger = warningLog();
    const loaded = await loadSettings(logger);
    expect(loaded.value).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(root)).toHaveLength(1);
    expect(loaded.quarantinedTo).toMatch(/config-\d{8}-\d{6}-\d{3}-utc\.invalid$/);
    expect(readFileSync(loaded.quarantinedTo!, "utf8")).toBe(bytes);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await saveSettings({ theme: "light" });
    expect(readStored()).toEqual({ theme: "light" });
    expect(readFileSync(loaded.quarantinedTo!, "utf8")).toBe(bytes);
  });
});
