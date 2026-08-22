/**
 * Settings persistence: the new-job option defaults plus app-level appearance (the
 * UI font), saved so they are configured once rather than every session. The file
 * lives at `config.json` under zipkit's storage root (`ZIPKIT_HOME` or `~/.zipkit`,
 * resolved in one place by the SDK's {@link storageRoot}, beside the queue and logs).
 * Parsing fills absent known fields but rejects wrong shapes. Invalid v1 bytes
 * are quarantined, future versions are preserved live, and non-absence I/O
 * failures propagate rather than being mistaken for first run.
 */

import { access } from "node:fs/promises";
import path from "node:path";
import { storageRoot } from "../../sdk/storage.js";
import { DEFAULT_OPTIONS, type GuiOptions, type GuiSettings } from "../shared/spec.js";
import { nullLog, type AppLog } from "./log.js";
import { InvalidManagedJsonError, isPlainObject, loadManagedJson, parseManagedObject, writeManagedJson, type ManagedJsonLoad } from "./managedJson.js";

/** The settings file under the resolved storage root. Computed lazily (not frozen
 *  into a module constant at import time) so `ZIPKIT_HOME` is read after the
 *  environment is set, per the storage-path convention. Exported so tests can pin
 *  the resolved filename against the actual derivation, not a duplicated literal. */
export function settingsFile(): string {
  return path.join(storageRoot(), "config.json");
}

function freshSettings(): GuiSettings {
  return { defaults: { ...DEFAULT_OPTIONS }, uiFontFamily: "" };
}

/** Parse settings-file text: fill absent fields and reject wrong known shapes. */
export function parseGuiOptions(raw: unknown, store: string): GuiOptions {
  if (raw === undefined) raw = {};
  if (!isPlainObject(raw)) throw new InvalidManagedJsonError(store, "options must be an object");
  const checks: Array<[keyof GuiOptions, (value: unknown) => boolean]> = [
    ["junk", (v) => typeof v === "boolean"], ["strict", (v) => typeof v === "boolean"],
    ["level", (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 9],
    ["symlinks", (v) => v === "ignore" || v === "preserve" || v === "follow"],
    ["emptyDirs", (v) => v === "keep" || v === "prune"], ["metadata", (v) => typeof v === "boolean"],
    ["hash", (v) => typeof v === "boolean"], ["comment", (v) => typeof v === "string"],
    ["outputDir", (v) => typeof v === "string"], ["fileName", (v) => typeof v === "string"],
    ["overwrite", (v) => typeof v === "boolean"],
  ];
  for (const [key, valid] of checks) {
    if (raw[key] !== undefined && !valid(raw[key])) {
      throw new InvalidManagedJsonError(store, `options.${key} has the wrong type or value`);
    }
  }
  return { ...DEFAULT_OPTIONS, ...raw } as GuiOptions;
}

export function parseSettings(text: string): GuiSettings {
  const root = parseManagedObject(text, "config.json");
  const defaults = parseGuiOptions(root.defaults, "config.json");
  if (root.uiFontFamily !== undefined && typeof root.uiFontFamily !== "string") {
    throw new InvalidManagedJsonError("config.json", "uiFontFamily must be a string");
  }
  const uiFontFamily = typeof root.uiFontFamily === "string" ? root.uiFontFamily : "";
  return { defaults, uiFontFamily };
}

/** Serialize the GUI settings to settings-file text. Pure. */
export function serializeSettings(settings: GuiSettings): string {
  return JSON.stringify(
    { version: 1, defaults: settings.defaults, uiFontFamily: settings.uiFontFamily },
    null,
    2,
  );
}

/** Load settings. Absence yields defaults; invalid v1 content is quarantined;
 * future versions and real read/preservation failures propagate. */
export async function loadSettings(logger: AppLog = nullLog): Promise<ManagedJsonLoad<GuiSettings>> {
  return loadManagedJson(settingsFile(), parseSettings, freshSettings, logger);
}

/** Persist the GUI settings through the shared managed-text atomic write (temp file + rename), so a
 *  crash mid-write cannot corrupt them, and the exact bytes are recorded to the data-backup store
 *  after the rename lands. config.json is managed text and RECORDS on every save (data-backup
 *  conventions). Throws on write failure; the caller logs it. */
export async function saveSettings(settings: GuiSettings): Promise<void> {
  await writeManagedJson(settingsFile(), serializeSettings(settings));
}

/** Create config.json from the built-in defaults on first run — only when it does not yet exist — so
 *  the settings file is present on disk immediately rather than only after the first save
 *  (storage-path conventions, "Materializing settings on first run"). An existing file is never
 *  inspected or overwritten (F_OK succeeds iff the file exists), so a good or hand-edited file is
 *  never at risk. Produced through saveSettings — the same serializer the normal save path uses, not
 *  a hand-built literal. Returns true when a file was created. */
export async function ensureSettingsFile(): Promise<boolean> {
  try {
    await access(settingsFile());
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await saveSettings(freshSettings());
    return true;
  }
}
