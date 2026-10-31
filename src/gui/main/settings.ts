/** Settings are whole user copies of independent sets; absent sets use code defaults.
 * Reads never create a config file. An invalid set falls back on its own while the
 * file keeps it as written, and keys this build does not know are kept too, so a
 * save never drops what it does not understand (config-sets conventions). A newer
 * or unreadable file is refused and stops the launch. Main holds the settings in
 * memory from the startup load on; every reader gets that copy, and only a save
 * changes it.
 */

import path from "node:path";
import { isSafePathComponent, exclusionIssue } from "zipkitsdk/types";
import { storageRoot } from "./storage.js";
import { changedSettings, DEFAULT_OPTIONS, parametersEqual, DEFAULT_PARAMETERS, DEFAULT_SETTINGS, PARAMETER_KEYS, SETTINGS_KEYS, THEME_PREFERENCES, type ArchiveParameters, type GuiOptions, type GuiSettings } from "../shared/spec.js";
import { isLanguage } from "../shared/i18n/languages.js";
import { COMPRESSION_LEVEL_RANGE, isCardRowLimit, isDisplayZone, isWholeNumberIn } from "../shared/spec.js";
import { singleLine } from "../shared/textCleanup.js";
import { nullLog, type AppLog } from "./log.js";
import { InvalidManagedJsonError, isPlainObject, loadManagedJson, managedJsonText, writeManagedJson, type ManagedJsonLoad } from "./managedJson.js";

/** Computed on each call, not frozen at import, so `ZIPKIT_DATA_DIR` is read after
 * the environment is set (storage-path conventions). */
export function settingsFile(): string {
  return path.join(storageRoot(), "config.json");
}

function freshSettings(): GuiSettings {
  return { ...DEFAULT_SETTINGS, newJobParameters: { ...DEFAULT_PARAMETERS } };
}

/** One exclusion pattern as the SDK takes it; a regex must compile. */
function isExclusion(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const p = value as Record<string, unknown>;
  if (typeof p.pattern !== "string" || p.pattern === "" || (p.match !== "glob" && p.match !== "regex")) return false;
  if (p.target !== "file" && p.target !== "dir" && p.target !== "both") return false;
  if (typeof p.ignoreCase !== "boolean" || (p.note !== undefined && typeof p.note !== "string")) return false;
  return exclusionIssue({ pattern: p.pattern, match: p.match, target: p.target }) === null;
}

const OPTION_CHECKS: Array<[keyof GuiOptions, (value: unknown) => boolean]> = [
  ["exclude", (v) => typeof v === "boolean"],
  ["exclusions", (v) => Array.isArray(v) && v.every(isExclusion)],
  ["strict", (v) => typeof v === "boolean"],
  ["invalidChars", (v) => v === "tidy" || v === "replace" || v === "fullwidth" || v === "remove"],
  ["level", (v) => isWholeNumberIn(v, COMPRESSION_LEVEL_RANGE)],
  ["symlinks", (v) => v === "ignore" || v === "preserve" || v === "follow"],
  ["emptyDirs", (v) => v === "keep" || v === "prune"], ["manifest", (v) => typeof v === "boolean"],
  ["manifestName", (v) => typeof v === "string" && isSafePathComponent(v)],
  ["hash", (v) => typeof v === "boolean"], ["comment", (v) => typeof v === "string"],
  ["outputDir", (v) => typeof v === "string"], ["fileName", (v) => typeof v === "string"],
  ["overwrite", (v) => typeof v === "boolean"],
];

const PARAMETER_CHECKS = OPTION_CHECKS.filter(([key]) => (PARAMETER_KEYS as readonly string[]).includes(key));

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
      case "newJobParameters":
        // Each parameter is independent of the others, so an invalid one reverts
        // alone.
        if (isPlainObject(value)) {
          const reverted: string[] = [];
          settings.newJobParameters = Object.fromEntries(PARAMETER_CHECKS.map(([member, valid]) => {
            if (valid(value[member])) return [member, value[member]];
            reverted.push(member);
            return [member, DEFAULT_PARAMETERS[member as keyof ArchiveParameters]];
          })) as unknown as ArchiveParameters;
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
      case "cardRowLimit":
        if (isCardRowLimit(value)) { settings.cardRowLimit = value; continue; }
        break;
      case "confirmJobRemoval":
        if (typeof value === "boolean") { settings.confirmJobRemoval = value; continue; }
        break;
      case "timeZone":
        if (value === "system" || isDisplayZone(value)) { settings.timeZone = value as string; continue; }
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

export function serializeSettings(stored: Record<string, unknown>): string {
  return managedJsonText("config", stored);
}

let current: GuiSettings = freshSettings();

/** What the loaded file held that this build does not take as written: keys it does not know, and
 *  sets whose value it could not use in full, each as written; and the settings as loaded, so a save
 *  can tell a set the user changed from one that still stands as the file had it. */
let kept: { unknownKeys: Record<string, unknown>; sets: Partial<Record<keyof GuiSettings, unknown>>; loaded: GuiSettings } = {
  unknownKeys: {},
  sets: {},
  loaded: freshSettings(),
};

const HEADER_KEYS = new Set(["format", "writer"]);

/** The loaded file was refused: no save may reach it (store-recovery conventions). */
let refusedFile: string | null = null;

/** Throw when the loaded config.json was refused, so no save path reaches it. */
export function admitSettingsSave(): void {
  if (refusedFile !== null) throw new Error(`${refusedFile} was refused at launch and is not saved over`);
}

/** Whether a set's value as written is not exactly what the reader took from it. */
function setNotTakenAsWritten(key: keyof GuiSettings, value: unknown, taken: GuiSettings): boolean {
  if (key !== "newJobParameters") return value !== taken[key];
  if (!isPlainObject(value)) return true;
  const known = PARAMETER_CHECKS.map(([member]) => member as string);
  return Object.keys(value).some((member) => !known.includes(member))
    || PARAMETER_CHECKS.some(([member, valid]) => value[member] !== undefined && !valid(value[member]));
}

function keptFrom(root: Record<string, unknown>, loaded: GuiSettings): typeof kept {
  const unknownKeys: Record<string, unknown> = {};
  const sets: Partial<Record<keyof GuiSettings, unknown>> = {};
  for (const [key, value] of Object.entries(root)) {
    if (HEADER_KEYS.has(key)) continue;
    if (!(SETTINGS_KEYS as readonly string[]).includes(key)) unknownKeys[key] = value;
    else if (setNotTakenAsWritten(key as keyof GuiSettings, value, loaded)) sets[key as keyof GuiSettings] = value;
  }
  return { unknownKeys, sets, loaded };
}

function sameSet(key: keyof GuiSettings, a: GuiSettings, b: GuiSettings): boolean {
  return key === "newJobParameters" ? parametersEqual(a.newJobParameters, b.newJobParameters) : a[key] === b[key];
}

/** What config.json holds for these settings: each set that differs from its built-in, a set kept
 *  as written while the user has not changed it, unknown parameter members beside a changed set,
 *  and every unknown key. */
export function storedSettings(effective: GuiSettings): Record<string, unknown> {
  const stored: Record<string, unknown> = { ...kept.unknownKeys, ...changedSettings(DEFAULT_SETTINGS, effective) };
  for (const [key, value] of Object.entries(kept.sets) as [keyof GuiSettings, unknown][]) {
    if (sameSet(key, effective, kept.loaded)) {
      stored[key] = value;
    } else if (key === "newJobParameters" && isPlainObject(value)) {
      const known = PARAMETER_CHECKS.map(([member]) => member as string);
      const unknownMembers = Object.fromEntries(Object.entries(value).filter(([member]) => !known.includes(member)));
      if (Object.keys(unknownMembers).length > 0) stored[key] = { ...unknownMembers, ...effective.newJobParameters };
    }
  }
  return stored;
}

/** The settings as last loaded or saved. */
export function currentSettings(): GuiSettings {
  return current;
}

/** Load config.json once, at startup, before any window exists. */
export async function loadSettings(logger: AppLog = nullLog): Promise<ManagedJsonLoad<GuiSettings>> {
  let read: typeof kept | null = null;
  const load = await loadManagedJson(settingsFile(), "config", (root) => {
    const settings = parseSettings(root, logger);
    read = keptFrom(root, settings);
    return settings;
  }, freshSettings, logger);
  current = load.value;
  kept = read ?? { unknownKeys: {}, sets: {}, loaded: load.value };
  refusedFile = load.refused?.file ?? null;
  return load;
}

/** The one owner of what config.json holds (config-sets conventions, Reading and
 * healing): the dialog's settings, checked by the reader's validator and compared
 * cleaned (text-cleanup conventions). Returns the effective settings. */
export function checkedSettings(settings: GuiSettings, logger: AppLog = nullLog): GuiSettings {
  for (const [key, valid] of PARAMETER_CHECKS) {
    if (!valid(settings.newJobParameters[key as keyof ArchiveParameters])) throw new Error(`Invalid archive parameter: ${key}`);
  }
  const checked = effectiveSettings(settings, logger);
  const effective: GuiSettings = {
    ...checked,
    uiFontFamily: singleLine(checked.uiFontFamily),
  };
  return effective;
}

export async function saveSettings(settings: GuiSettings, logger: AppLog = nullLog): Promise<GuiSettings> {
  admitSettingsSave();
  const effective = checkedSettings(settings, logger);
  const stored = storedSettings(effective);
  // Settings that are all built-in leave no file behind; identical bytes are not rewritten.
  // config.json holds the user's own settings, so each launch's last saved copy is backed up.
  await writeManagedJson(settingsFile(), serializeSettings(stored), { createAbsent: Object.keys(stored).length > 0, record: true, kind: "config" });
  current = effective;
  return effective;
}
