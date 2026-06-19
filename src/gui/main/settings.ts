/**
 * Settings persistence: the defaults for new jobs, saved so they are configured
 * once rather than every session. The file lives at `settings.json` under
 * zipkit's storage root (`ZIPKIT_HOME` or `~/.zipkit`, resolved in one place by
 * the SDK's {@link storageRoot}, beside the queue and logs). Parsing is pure and
 * defensive (fills missing fields from the built-in defaults, never throws) so a
 * stale or corrupt file degrades to the shipped defaults rather than crashing;
 * the file I/O is the best-effort edge and its failures are logged by the caller.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { storageRoot } from "../../sdk/storage.js";
import { DEFAULT_OPTIONS, type GuiOptions } from "../shared/spec.js";

/** The settings file under the resolved storage root. Computed lazily (not frozen
 *  into a module constant at import time) so `ZIPKIT_HOME` is read after the
 *  environment is set, per the storage-path convention. */
function settingsFile(): string {
  return path.join(storageRoot(), "settings.json");
}

/** Parse settings-file text into the new-job defaults: fill any missing option
 *  field from the built-in defaults. Pure; never throws. */
export function parseSettings(text: string): GuiOptions {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
  const defaults = (doc as { defaults?: unknown } | null)?.defaults;
  if (defaults === null || typeof defaults !== "object") return { ...DEFAULT_OPTIONS };
  return { ...DEFAULT_OPTIONS, ...(defaults as Partial<GuiOptions>) };
}

/** Serialize the new-job defaults to settings-file text. Pure. */
export function serializeSettings(defaults: GuiOptions): string {
  return JSON.stringify({ version: 1, defaults }, null, 2);
}

/** Load the persisted defaults; the built-in defaults if there is no readable file. */
export async function loadSettings(): Promise<GuiOptions> {
  try {
    return parseSettings(await readFile(settingsFile(), "utf8"));
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}

/** Persist the new-job defaults atomically (temp file + rename), so a crash
 *  mid-write cannot corrupt them. Throws on write failure; the caller logs it. */
export async function saveSettings(defaults: GuiOptions): Promise<void> {
  const file = settingsFile();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, serializeSettings(defaults), "utf8");
  await rename(tmp, file);
}
