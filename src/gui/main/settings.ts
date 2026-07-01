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

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { storageRoot } from "../../sdk/storage.js";
import { DEFAULT_OPTIONS, type GuiOptions, type GuiSettings } from "../shared/spec.js";

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

/** Load the persisted settings; the built-in defaults if there is no readable file. */
export async function loadSettings(): Promise<GuiSettings> {
  try {
    return parseSettings(await readFile(settingsFile(), "utf8"));
  } catch {
    return freshSettings();
  }
}

/** Persist the GUI settings atomically (temp file + rename), so a crash mid-write
 *  cannot corrupt them. Throws on write failure; the caller logs it. */
export async function saveSettings(settings: GuiSettings): Promise<void> {
  const file = settingsFile();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, serializeSettings(settings), "utf8");
  await rename(tmp, file);
}
