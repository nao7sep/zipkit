/** Settings are whole user copies of independent sets; absent sets use code defaults.
 * Reads never create a config file. Invalid sets fall back independently, while
 * unreadable documents follow the shared managed-store quarantine path.
 */

import path from "node:path";
import pLimit from "p-limit";
import { storageRoot } from "../../sdk/storage.js";
import { DEFAULT_OPTIONS, SETTINGS_KEYS, THEME_PREFERENCES, type GuiOptions, type GuiSettings, type GuiSettingsChanges } from "../shared/spec.js";
import { isLanguage } from "../shared/i18n/languages.js";
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

function effectiveSettings(root: Record<string, unknown>, logger: AppLog): GuiSettings {
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
    logger.warn("invalid settings set; using the built-in", { key });
  }
  return settings;
}

export function parseSettings(text: string, logger: AppLog = nullLog): GuiSettings {
  return effectiveSettings(parseJsonObject(text, "config.json"), logger);
}

/** Serialize only known set keys and members, without config metadata. */
export function serializeSettings(settings: Record<string, unknown> | GuiSettingsChanges): string {
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

// Electron's single-instance lock gives config one process owner. Serialize the
// patch path so concurrent requests cannot overwrite one another's untouched sets.
const settingsWrites = pLimit(1);

/** Read-modify-write only requested sets; null deletes a copy. */
export function saveSettings(changes: GuiSettingsChanges, logger: AppLog = nullLog): Promise<GuiSettings> {
  const snapshot = structuredClone(changes);
  return settingsWrites(async () => {
    const { value: stored } = await loadManagedJson<Record<string, unknown>>(settingsFile(), (text) => parseJsonObject(text, "config.json"), () => ({}), logger);
    for (const key of SETTINGS_KEYS) {
      if (!Object.hasOwn(snapshot, key)) continue;
      if (snapshot[key] === null) delete stored[key];
      else stored[key] = snapshot[key];
    }
    const text = serializeSettings(stored);
    await writeManagedJson(settingsFile(), text);
    return parseSettings(text, logger);
  });
}
