/** Settings are whole user copies of independent sets; absent sets use code defaults.
 * Reads never create a config file. Invalid sets fall back independently, while
 * unreadable documents follow the shared managed-store quarantine path.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { storageRoot } from "../../sdk/storage.js";
import { DEFAULT_OPTIONS, DEFAULT_SETTINGS, optionsEqual, SETTINGS_KEYS, THEME_PREFERENCES, type GuiOptions, type GuiSettings } from "../shared/spec.js";
import { isLanguage } from "../shared/i18n/languages.js";
import { multiline, singleLine } from "../shared/textCleanup.js";
import { nullLog, type AppLog } from "./log.js";
import { InvalidManagedJsonError, isPlainObject, loadManagedJson, parseJsonObject, writeManagedJson, type ManagedJsonLoad } from "./managedJson.js";

export function settingsFile(): string {
  return path.join(storageRoot(), "config.json");
}

function freshSettings(): GuiSettings {
  return { defaults: { ...DEFAULT_OPTIONS }, uiFontFamily: "", theme: "system", language: "system" };
}

const OPTION_CHECKS: Array<[keyof GuiOptions, (value: unknown) => boolean]> = [
  ["junk", (v) => typeof v === "boolean"], ["strict", (v) => typeof v === "boolean"],
  ["level", (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 9],
  ["symlinks", (v) => v === "ignore" || v === "preserve" || v === "follow"],
  ["emptyDirs", (v) => v === "keep" || v === "prune"], ["metadata", (v) => typeof v === "boolean"],
  ["hash", (v) => typeof v === "boolean"], ["comment", (v) => typeof v === "string"],
  ["outputDir", (v) => typeof v === "string"], ["fileName", (v) => typeof v === "string"],
  ["overwrite", (v) => typeof v === "boolean"],
];

/** Queue options retain their existing absent-field behavior. Config defaults
 * additionally require every member before calling this parser. */
export function parseGuiOptions(raw: unknown, store: string): GuiOptions {
  if (raw === undefined) raw = {};
  if (!isPlainObject(raw)) throw new InvalidManagedJsonError(store, "options must be an object");
  for (const [key, valid] of OPTION_CHECKS) {
    if (raw[key] !== undefined && !valid(raw[key])) {
      throw new InvalidManagedJsonError(store, `options.${key} has the wrong type or value`);
    }
  }
  return Object.fromEntries(OPTION_CHECKS.map(([key]) => [key, raw[key] ?? DEFAULT_OPTIONS[key]])) as unknown as GuiOptions;
}

// Invalid copies can be read at startup, by IPC, and after saves. One process
// reports each set key once while every read still falls back independently.
const warnedSettingsKeys = new Set<keyof GuiSettings>();

function effectiveSettings(root: Partial<Record<keyof GuiSettings, unknown>>, logger: AppLog): GuiSettings {
  const settings = freshSettings();
  for (const key of SETTINGS_KEYS) {
    if (!Object.hasOwn(root, key)) continue;
    const value = root[key];
    switch (key) {
      case "defaults":
        if (isPlainObject(value) && OPTION_CHECKS.every(([member, valid]) => valid(value[member]))) {
          settings.defaults = parseGuiOptions(value, "config.json");
          continue;
        }
        break;
      case "uiFontFamily":
        if (typeof value === "string") { settings.uiFontFamily = value; continue; }
        break;
      case "theme":
        if (THEME_PREFERENCES.includes(value as GuiSettings["theme"])) {
          settings.theme = value as GuiSettings["theme"];
          continue;
        }
        break;
      case "language":
        if (value === "system" || isLanguage(value)) { settings.language = value; continue; }
        break;
    }
    if (!warnedSettingsKeys.has(key)) {
      warnedSettingsKeys.add(key);
      logger.warn("invalid settings set; using the built-in", { key });
    }
  }
  return settings;
}

export function parseSettings(text: string, logger: AppLog = nullLog): GuiSettings {
  return effectiveSettings(parseJsonObject(text, "config.json"), logger);
}

/** Serialize only known set keys and members, without config metadata. */
export function serializeSettings(settings: Record<string, unknown>): string {
  const stored: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    if (!Object.hasOwn(settings, key)) continue;
    const value = settings[key];
    stored[key] = key === "defaults" && isPlainObject(value)
      ? Object.fromEntries(OPTION_CHECKS.filter(([member]) => Object.hasOwn(value, member)).map(([member]) => [member, value[member]]))
      : value;
  }
  return JSON.stringify(stored, null, 2);
}

export async function loadSettings(logger: AppLog = nullLog): Promise<ManagedJsonLoad<GuiSettings>> {
  return loadManagedJson(settingsFile(), (text) => parseSettings(text, logger), freshSettings, logger);
}

async function storedText(): Promise<string | null> {
  try {
    return await readFile(settingsFile(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// Electron's single-instance lock gives config one process owner. Serialize the
// patch path so concurrent requests cannot overwrite one another's untouched sets.
const settingsWrites = pLimit(1);

/** The one owner of what config.json holds (config-sets conventions, Reading and
 * healing): the dialog's settings, checked by the reader's validator and compared
 * cleaned (text-cleanup conventions). Returns the effective settings. */
export function saveSettings(settings: GuiSettings, logger: AppLog = nullLog): Promise<GuiSettings> {
  const snapshot = structuredClone(settings);
  return settingsWrites(async () => {
    const checked = effectiveSettings(snapshot, logger);
    const effective: GuiSettings = {
      ...checked,
      uiFontFamily: singleLine(checked.uiFontFamily),
      defaults: { ...checked.defaults, comment: multiline(checked.defaults.comment) },
    };
    const stored: Record<string, unknown> = {};
    for (const key of SETTINGS_KEYS) {
      const builtIn = key === "defaults" ? optionsEqual(effective.defaults, DEFAULT_OPTIONS) : effective[key] === DEFAULT_SETTINGS[key];
      if (!builtIn) stored[key] = effective[key];
    }
    const text = serializeSettings(stored);
    const current = await storedText();
    if (current === null ? Object.keys(stored).length > 0 : current !== text) {
      await writeManagedJson(settingsFile(), text);
    }
    return effective;
  });
}
