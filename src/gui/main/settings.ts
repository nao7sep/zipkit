/** Settings are whole user copies of independent sets; absent sets use code defaults.
 * Reads never create a config file. Invalid sets fall back independently, while
 * unreadable documents follow the shared managed-store quarantine path.
 */

import { managedIO } from "./managed-io.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { storageRoot } from "../../sdk/storage.js";
import { changedSettings, DEFAULT_OPTIONS, DEFAULT_SETTINGS, SETTINGS_KEYS, THEME_PREFERENCES, type GuiOptions, type GuiSettings } from "../shared/spec.js";
import { isLanguage } from "../shared/i18n/languages.js";
import { multiline, singleLine } from "../shared/textCleanup.js";
import { nullLog, type AppLog } from "./log.js";
import { FORMAT_VERSIONS } from "./formatVersions.js";
import { InvalidManagedJsonError, isPlainObject, loadManagedJson, managedJsonText, writeManagedJson, type ManagedJsonLoad } from "./managedJson.js";

/** Computed on each call, not frozen at import, so `ZIPKIT_DATA_DIR` is read after
 * the environment is set (storage-path conventions). */
export function settingsFile(): string {
  return path.join(storageRoot(), "config.json");
}

function freshSettings(): GuiSettings {
  return { ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_OPTIONS } };
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

/** Parse a queued job's options: fill absent members and reject wrong known shapes. */
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

function effectiveSettings(root: Partial<Record<keyof GuiSettings, unknown>>, logger: AppLog): GuiSettings {
  const settings = freshSettings();
  for (const key of SETTINGS_KEYS) {
    if (!Object.hasOwn(root, key)) continue;
    const value = root[key];
    switch (key) {
      case "defaults":
        if (isPlainObject(value) && OPTION_CHECKS.every(([member, valid]) => valid(value[member]))) {
          settings.defaults = Object.fromEntries(OPTION_CHECKS.map(([member]) => [member, value[member]])) as unknown as GuiOptions;
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

/** The settings config.json's root object holds; each set is checked on its own. */
export function parseSettings(root: Record<string, unknown>, logger: AppLog = nullLog): GuiSettings {
  return effectiveSettings(root, logger);
}

export function serializeSettings(stored: Partial<GuiSettings>): string {
  return managedJsonText(FORMAT_VERSIONS.config, stored);
}

export async function loadSettings(logger: AppLog = nullLog): Promise<ManagedJsonLoad<GuiSettings>> {
  return loadManagedJson(settingsFile(), FORMAT_VERSIONS.config, (root) => parseSettings(root, logger), freshSettings, logger);
}

async function storedText(): Promise<string | null> {
  try {
    return await managedIO(settingsFile(), (signal) => readFile(settingsFile(), { encoding: "utf8", signal }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** The one owner of what config.json holds (config-sets conventions, Reading and
 * healing): the dialog's settings, checked by the reader's validator and compared
 * cleaned (text-cleanup conventions). Returns the effective settings. */
export async function saveSettings(settings: GuiSettings, logger: AppLog = nullLog): Promise<GuiSettings> {
  const checked = effectiveSettings(settings, logger);
  const effective: GuiSettings = {
    ...checked,
    uiFontFamily: singleLine(checked.uiFontFamily),
    defaults: { ...checked.defaults, comment: multiline(checked.defaults.comment) },
  };
  const stored = changedSettings(DEFAULT_SETTINGS, effective);
  const text = serializeSettings(stored);
  const current = await storedText();
  if (current === null ? Object.keys(stored).length > 0 : current !== text) {
    await writeManagedJson(settingsFile(), text);
  }
  return effective;
}
