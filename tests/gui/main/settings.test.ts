/** Whole-set reads, writes from the dialog's settings, and managed-file recovery. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppLog } from "../../../src/gui/main/log.js";
import { storageRoot } from "../../../src/gui/main/storage.js";
import { DEFAULT_PARAMETERS, DEFAULT_SETTINGS } from "../../../src/gui/shared/spec";
import { singleLine } from "../../../src/gui/shared/textCleanup";
import { managedEntries } from "../../helpers/managedEntries.js";
import { headed, headedText } from "../../helpers/fileHeader.js";

import * as settings from "../../../src/gui/main/settings";
import { record } from "../../../src/gui/main/backupStore.js";

vi.mock("../../../src/gui/main/backupStore.js", () => ({ record: vi.fn() }));

function warningLog() {
  const logger: AppLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return logger;
}

const CUSTOM = {
  newJobParameters: { ...DEFAULT_PARAMETERS, level: 9, strict: true },
  uiFontFamily: "Iosevka, monospace",
  theme: "dark" as const,
  language: "pt-BR" as const,
  timeZone: "America/Sao_Paulo",
  confirmJobRemoval: false,
  cardRowLimit: 9,
};

describe("settings sets", () => {
  it("round-trips whole settings behind the file header", () => {
    expect(settings.parseSettings(JSON.parse(settings.serializeSettings(CUSTOM)))).toEqual(CUSTOM);
    expect(JSON.parse(settings.serializeSettings(CUSTOM))).toEqual(headed("config", CUSTOM));
    expect(Object.keys(JSON.parse(settings.serializeSettings(CUSTOM))).slice(0, 2)).toEqual(["format", "writer"]);
  });

  it("keeps a saved display zone and reverts only an unknown one, logging it", () => {
    expect(settings.parseSettings({ timeZone: "Asia/Tokyo" }).timeZone).toBe("Asia/Tokyo");
    const logger = warningLog();
    expect(settings.parseSettings({ timeZone: "+09:00", theme: "dark" }, logger)).toEqual({ ...DEFAULT_SETTINGS, theme: "dark" });
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { key: "timeZone" });
  });

  it("reads one set with every absent set using its built-in", () => {
    expect(settings.parseSettings({ theme: "light" })).toEqual({ ...DEFAULT_SETTINGS, theme: "light" });
    expect(settings.parseSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it.each([null, 5, "text", [1]])("falls back for a newJobParameters set that is not an object: %j", (newJobParameters) => {
    const logger = warningLog();
    expect(settings.parseSettings({ newJobParameters, theme: "dark" }, logger)).toEqual({ ...DEFAULT_SETTINGS, theme: "dark" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { key: "newJobParameters" });
  });

  it.each([
    ["hash", "yes"],
    ["level", 10],
    ["symlinks", "unknown"],
    ["exclusions", [{ pattern: "(", match: "regex", target: "both", ignoreCase: false }]],
    ["exclusions", [{ pattern: "", match: "glob", target: "both", ignoreCase: false }]],
    ["manifestName", ""],
    ["manifestName", "a/../b"],
    ["manifestName", "a/b"],
    ["exclusions", [{ pattern: "cache/", match: "glob", target: "file", ignoreCase: false }]],
  ] as const)("reverts only an invalid %s, keeping the authored parameters beside it", (member, bad) => {
    const authored = CUSTOM.newJobParameters;
    const logger = warningLog();
    expect(settings.parseSettings({ newJobParameters: { ...authored, [member]: bad } }, logger).newJobParameters)
      .toEqual({ ...authored, [member]: DEFAULT_PARAMETERS[member] });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { key: "newJobParameters", members: [member] });
  });

  it("names every reverted member, absent ones included, in one warning", () => {
    const logger = warningLog();
    expect(settings.parseSettings({ newJobParameters: { level: 1 } }, logger).newJobParameters)
      .toEqual({ ...DEFAULT_PARAMETERS, level: 1 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0]![1]?.members).toHaveLength(9);
  });

  it.each(["a/../b", "a/b", "CON", "bad:name.json"])("refuses an unsafe authored manifest name instead of reverting it: %s", (manifestName) => {
    expect(() => settings.checkedSettings({ ...CUSTOM, newJobParameters: { ...CUSTOM.newJobParameters, manifestName } })).toThrow("Invalid archive parameter: manifestName");
  });

  it("refuses a folder glob targeting files instead of reverting the exclusion list", () => {
    const exclusions = [{ pattern: "cache/", match: "glob" as const, target: "file" as const, ignoreCase: false }];
    expect(() => settings.checkedSettings({ ...CUSTOM, newJobParameters: { ...CUSTOM.newJobParameters, exclusions } })).toThrow("Invalid archive parameter: exclusions");
  });

  it("keeps a corrected safe manifest name while the manifest is disabled", () => {
    const authored = { ...CUSTOM, newJobParameters: { ...CUSTOM.newJobParameters, manifest: false, manifestName: "record.json" } };
    expect(settings.checkedSettings(authored)).toEqual(authored);
  });

  it("invalid scalar sets warn independently without affecting valid new-job parameters", () => {
    const logger = warningLog();
    expect(settings.parseSettings({ newJobParameters: CUSTOM.newJobParameters, uiFontFamily: 42, theme: "sepia", language: "unknown" }, logger))
      .toEqual({ ...DEFAULT_SETTINGS, newJobParameters: CUSTOM.newJobParameters });
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(vi.mocked(logger.warn).mock.calls.map((call) => call[1]?.key).sort()).toEqual(["language", "theme", "uiFontFamily"]);
  });

});

describe("settings file location and persistence", () => {
  let root: string;
  const prev = process.env.ZIPKIT_DATA_DIR;
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "zipkit-home-"));
    process.env.ZIPKIT_DATA_DIR = root;
    // Main always loads before it saves; a load of the empty root starts each test from nothing kept.
    await settings.loadSettings();
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.ZIPKIT_DATA_DIR;
    else process.env.ZIPKIT_DATA_DIR = prev;
    await rm(root, { recursive: true, force: true });
  });

  const readStored = () => JSON.parse(readFileSync(settings.settingsFile(), "utf8"));
  const stored = (sets: Record<string, unknown>) => headed("config", sets);

  it("resolves config.json separately from layout and queue", () => {
    expect(settings.settingsFile()).toBe(path.join(storageRoot(), "config.json"));
    expect(settings.settingsFile()).not.toBe(path.join(storageRoot(), "layout.json"));
    expect(settings.settingsFile()).not.toBe(path.join(storageRoot(), "queue.json"));
  });

  it("loads a fresh home without writing config.json", async () => {
    expect(await settings.loadSettings()).toEqual({ value: DEFAULT_SETTINGS, missing: true, refused: null });
    expect(existsSync(settings.settingsFile())).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("changing one new-job parameter writes exactly the whole newJobParameters set", async () => {
    const newJobParameters = { ...DEFAULT_PARAMETERS, level: 3 };
    expect(await settings.saveSettings({ ...DEFAULT_SETTINGS, newJobParameters })).toEqual({ ...DEFAULT_SETTINGS, newJobParameters });
    expect(readStored()).toEqual(stored({ newJobParameters }));
    expect((await settings.loadSettings()).value).toEqual({ ...DEFAULT_SETTINGS, newJobParameters });
    expect(managedEntries(root)).toEqual(["config.json"]);
  });

  it("a reset on a fresh data directory creates no file", async () => {
    expect(await settings.saveSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(readdirSync(root)).toEqual([]);
  });

  it("writes the file from the settings it is given, every set that differs", async () => {
    writeFileSync(settings.settingsFile(), headedText("config", { language: "de", uiFontFamily: "Menlo" }));
    await settings.saveSettings({ ...DEFAULT_SETTINGS, theme: "dark" });
    expect(readStored()).toEqual(stored({ theme: "dark" }));
  });

  it("keeps unknown sets and unknown newJobParameters members on every write", async () => {
    writeFileSync(settings.settingsFile(), headedText("config", { later: { a: 1 }, newJobParameters: { ...CUSTOM.newJobParameters, later: "kept" } }));
    const loaded = (await settings.loadSettings()).value;
    expect(loaded.newJobParameters).toEqual(CUSTOM.newJobParameters);
    await settings.saveSettings({ ...loaded, theme: "light" });
    expect(readStored()).toEqual(stored({ later: { a: 1 }, newJobParameters: { ...CUSTOM.newJobParameters, later: "kept" }, theme: "light" }));
    // Changing the parameters writes the new values and still keeps the member this build does not know.
    await settings.saveSettings({ ...loaded, theme: "light", newJobParameters: { ...CUSTOM.newJobParameters, level: 3 } });
    expect(readStored()).toEqual(stored({ later: { a: 1 }, newJobParameters: { later: "kept", ...CUSTOM.newJobParameters, level: 3 }, theme: "light" }));
  });

  it("a reset removes newJobParameters and keeps other stored sets", async () => {
    await settings.saveSettings(CUSTOM);
    expect(await settings.saveSettings({ ...CUSTOM, newJobParameters: DEFAULT_PARAMETERS })).toEqual({ ...CUSTOM, newJobParameters: DEFAULT_PARAMETERS });
    expect(readStored()).toEqual(stored({ uiFontFamily: CUSTOM.uiFontFamily, theme: CUSTOM.theme, language: CUSTOM.language, timeZone: CUSTOM.timeZone, confirmJobRemoval: false, cardRowLimit: 9 }));
  });

  it("removes a stored copy identical to the built-in and keeps the file with no sets", async () => {
    writeFileSync(settings.settingsFile(), headedText("config", { newJobParameters: DEFAULT_PARAMETERS }));
    await settings.saveSettings(DEFAULT_SETTINGS);
    expect(readStored()).toEqual(stored({}));
  });

  it("writes nothing when the file would not change", async () => {
    vi.mocked(record).mockClear();
    await settings.saveSettings(CUSTOM);
    await settings.saveSettings(CUSTOM);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("compares and stores the font cleaned", async () => {
    const blank = { ...DEFAULT_SETTINGS, uiFontFamily: " \n " };
    expect(await settings.saveSettings(blank)).toEqual(DEFAULT_SETTINGS);
    expect(readdirSync(root)).toEqual([]);
    await settings.saveSettings({ ...DEFAULT_SETTINGS, uiFontFamily: " Menlo\n" });
    expect(readStored()).toEqual(stored({ uiFontFamily: "Menlo" }));
  });

  it("keeps the built-in texts in cleaned form", () => {
    expect(singleLine(DEFAULT_SETTINGS.uiFontFamily)).toBe(DEFAULT_SETTINGS.uiFontFamily);
  });

  it("a malformed set remains in place and only falls back for that set", async () => {
    const bytes = headedText("config", { newJobParameters: 5, theme: "dark" });
    writeFileSync(settings.settingsFile(), bytes);
    const logger = warningLog();
    expect(await settings.loadSettings(logger)).toEqual({ value: { ...DEFAULT_SETTINGS, theme: "dark" }, missing: false, refused: null });
    expect(readFileSync(settings.settingsFile(), "utf8")).toBe(bytes);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("an invalid member reverts alone in use, and the file keeps it as written until the parameters change", async () => {
    const authored = { ...DEFAULT_PARAMETERS, strict: true, symlinks: "follow" as const };
    writeFileSync(settings.settingsFile(), headedText("config", { newJobParameters: { ...authored, level: 42 } }));
    const loaded = (await settings.loadSettings()).value;
    expect(loaded.newJobParameters).toEqual(authored);
    await settings.saveSettings({ ...loaded, theme: "dark" });
    expect(readStored()).toEqual(stored({ newJobParameters: { ...authored, level: 42 }, theme: "dark" }));
    await settings.saveSettings({ ...loaded, theme: "dark", newJobParameters: { ...authored, level: 3 } });
    expect(readStored()).toEqual(stored({ newJobParameters: { ...authored, level: 3 }, theme: "dark" }));
  });

  it("an invalid set is kept as written while the user leaves it alone", async () => {
    writeFileSync(settings.settingsFile(), headedText("config", { newJobParameters: 5, theme: "sepia" }));
    const loaded = (await settings.loadSettings()).value;
    expect(loaded).toEqual(DEFAULT_SETTINGS);
    await settings.saveSettings({ ...loaded, language: "ja" });
    expect(readStored()).toEqual(stored({ newJobParameters: 5, theme: "sepia", language: "ja" }));
    await settings.saveSettings({ ...loaded, language: "ja", theme: "dark" });
    expect(readStored()).toEqual(stored({ newJobParameters: 5, theme: "dark", language: "ja" }));
  });

  it("main keeps the loaded and saved settings: a later change on disk is not read back", async () => {
    writeFileSync(settings.settingsFile(), headedText("config", { theme: "dark" }));
    await settings.loadSettings();
    expect(settings.currentSettings()).toEqual({ ...DEFAULT_SETTINGS, theme: "dark" });
    writeFileSync(settings.settingsFile(), headedText("config", { theme: "light" }));
    expect(settings.currentSettings().theme).toBe("dark");
    expect(await settings.saveSettings(CUSTOM)).toEqual(CUSTOM);
    expect(settings.currentSettings()).toEqual(CUSTOM);
  });

  it("a failed save leaves main's settings as they were", async () => {
    await settings.saveSettings({ ...DEFAULT_SETTINGS, theme: "dark" });
    writeFileSync(settings.settingsFile(), "{ damaged");
    await expect(settings.saveSettings(CUSTOM)).rejects.toThrow("is invalid");
    expect(settings.currentSettings()).toEqual({ ...DEFAULT_SETTINGS, theme: "dark" });
  });

  it("reads a file by its format header alone, whatever its writer says", async () => {
    writeFileSync(settings.settingsFile(), JSON.stringify({ ...headed("config", { theme: "dark" }), writer: { name: "elsewhere", version: 3 } }));
    expect(await settings.loadSettings()).toEqual({ value: { ...DEFAULT_SETTINGS, theme: "dark" }, missing: false, refused: null });
  });

  it("refuses a file of a newer format and never saves over it", async () => {
    const file = settings.settingsFile();
    const bytes = JSON.stringify({ ...headed("config", { theme: "dark" }), format: { owner: "zipkit", kind: "config", version: 2 } });
    writeFileSync(file, bytes);
    expect(await settings.loadSettings()).toEqual({ value: DEFAULT_SETTINGS, missing: false, refused: { file, reason: "newer" } });
    await expect(settings.saveSettings({ ...DEFAULT_SETTINGS, theme: "light" })).rejects.toThrow(/refused at launch/);
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(readdirSync(root)).toEqual(["config.json"]);
  });

  it.each([
    "{ not json", "[]", "null", "5",
    '{"theme":"dark"}',
    '{"format":"config","theme":"dark"}',
    '{"format":{"owner":"otherapp","kind":"config","version":1},"theme":"dark"}',
    '{"format":{"owner":"zipkit","kind":"queue","version":1},"theme":"dark"}',
    '{"format":{"owner":"zipkit","kind":"config","version":0},"theme":"dark"}',
    '{"format":{"owner":"zipkit","kind":"config"},"theme":"dark"}',
  ])("refuses an unreadable file and never saves over it: %s", async (bytes) => {
    const file = settings.settingsFile();
    writeFileSync(file, bytes);
    const loaded = await settings.loadSettings(warningLog());
    expect(loaded).toEqual({ value: DEFAULT_SETTINGS, missing: false, refused: { file, reason: "unreadable" } });
    await expect(settings.saveSettings({ ...loaded.value, theme: "light" })).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(readdirSync(root)).toEqual(["config.json"]);
  });
});
