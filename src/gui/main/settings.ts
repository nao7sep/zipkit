/** Settings are whole user copies of independent sets; absent sets use code defaults.
 * Reads never create a config file. Invalid sets fall back independently, while
 * unreadable documents follow the shared managed-store set-aside path. Main holds
 * the settings in memory from the startup load on; every reader gets that copy,
 * and only a save changes it.
 */

import path from "node:path";
import { storageRoot } from "../../sdk/storage.js";
import { changedSettings, DEFAULT_OPTIONS, DEFAULT_SETTINGS, SETTINGS_KEYS, THEME_PREFERENCES, type GuiOptions, type GuiSettings } from "../shared/spec.js";
import { isLanguage } from "../shared/i18n/languages.js";
import { multiline, singleLine } from "../shared/textCleanup.js";
import { nullLog, type AppLog } from "./log.js";
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
        // Each job option is independent of the others, so an invalid one reverts alone
        // and the authored comment, output folder and file name beside it survive.
        if (isPlainObject(value)) {
          const reverted: string[] = [];
          settings.defaults = Object.fromEntries(OPTION_CHECKS.map(([member, valid]) => {
            if (valid(value[member])) return [member, value[member]];
            reverted.push(member);
            return [member, DEFAULT_OPTIONS[member]];
          })) as unknown as GuiOptions;
          if (reverted.length > 0) logger.warn("invalid default job options; using their built-ins", { key, members: reverted });
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
  return managedJsonText(stored);
}

let current: GuiSettings = freshSettings();

/** The settings as last loaded or saved. */
export function currentSettings(): GuiSettings {
  return current;
}

/** Load config.json once, at startup, before any window exists. */
export async function loadSettings(logger: AppLog = nullLog): Promise<ManagedJsonLoad<GuiSettings>> {
  const load = await loadManagedJson(settingsFile(), (root) => parseSettings(root, logger), freshSettings, logger);
  current = load.value;
  return load;
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
  // Settings that are all built-in leave no file behind; identical bytes are not rewritten.
  // config.json holds the user's own settings, so each launch's last saved copy is backed up.
  await writeManagedJson(settingsFile(), serializeSettings(stored), { createAbsent: Object.keys(stored).length > 0, record: true });
  current = effective;
  return effective;
}
