/**
 * Settings persistence: the new-job option defaults plus app-level appearance (the
 * UI font), saved so they are configured once rather than every session. The file
 * lives at `config.json` under zipkit's storage root (`ZIPKIT_HOME` or `~/.zipkit`,
 * resolved in one place by the SDK's {@link storageRoot}, beside the queue and logs).
 * Parsing is pure and defensive (fills missing fields from the built-in defaults,
 * never throws) so a stale or corrupt file — or one written before a field existed —
 * degrades to the shipped defaults rather than crashing; the file I/O is the
 * best-effort edge and its failures are logged by the caller.
 */

import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { storageRoot } from "../../sdk/storage.js";
import { DEFAULT_OPTIONS, type GuiOptions, type GuiSettings } from "../shared/spec.js";
import { nullLog, type AppLog } from "./log.js";
import { isInvalidJson, loadManagedJson } from "./managedJson.js";

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

/** Parse settings-file text into the GUI settings: fill any missing option field
 *  from the built-in defaults, and a missing/non-string UI font from blank. Pure;
 *  never throws. */
export function parseSettings(text: string): GuiSettings {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return freshSettings();
  }
  const root = doc as { defaults?: unknown; uiFontFamily?: unknown } | null;
  const rawDefaults = root?.defaults;
  const defaults =
    rawDefaults !== null && typeof rawDefaults === "object"
      ? { ...DEFAULT_OPTIONS, ...(rawDefaults as Partial<GuiOptions>) }
      : { ...DEFAULT_OPTIONS };
  const uiFontFamily = typeof root?.uiFontFamily === "string" ? root.uiFontFamily : "";
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

/** Load the persisted settings; the built-in defaults if there is no readable file. A present-but-
 *  corrupt file (invalid JSON) is quarantined aside — never silently reset in place — before the
 *  defaults are returned; a quarantine-rename failure propagates rather than degrading to defaults
 *  over the corrupt bytes. The shared {@link loadManagedJson} owns that quarantine-outside-the-catch
 *  shape, identical to layout.json and queue.json. */
export async function loadSettings(logger: AppLog = nullLog): Promise<GuiSettings> {
  return loadManagedJson(settingsFile(), isInvalidJson, parseSettings, freshSettings, "default", logger);
}

/** Persist the GUI settings atomically (temp file + rename), so a crash mid-write
 *  cannot corrupt them. The temp is `<stem>-<nanoid>.tmp` in the same directory
 *  (storage-path conventions' derived-filename grammar). Throws on write failure;
 *  the caller logs it. */
export async function saveSettings(settings: GuiSettings): Promise<void> {
  const file = settingsFile();
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${path.parse(file).name}-${nanoid()}.tmp`);
  await writeFile(tmp, serializeSettings(settings), "utf8");
  await rename(tmp, file);
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
  } catch {
    await saveSettings(freshSettings());
    return true;
  }
}
