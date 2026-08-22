/** Shared safe loading and atomic writing for the GUI's managed JSON stores. */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { defaultSessionTimestamp } from "../../sdk/log/session.js";
import { record } from "./backupStore.js";
import { nullLog, type AppLog } from "./log.js";

export class InvalidManagedJsonError extends Error {
  constructor(store: string, detail: string) {
    super(`${store} is invalid: ${detail}`);
    this.name = "InvalidManagedJsonError";
  }
}

export class UnsupportedManagedJsonVersionError extends Error {
  constructor(store: string, version: unknown) {
    super(`${store} uses unsupported schema version ${String(version)}`);
    this.name = "UnsupportedManagedJsonVersionError";
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse the shared versioned document envelope. Future versions are not
 * quarantined: preserving their live bytes is safer than treating newer data as
 * corrupt and replacing it with this build's defaults. */
export function parseManagedObject(text: string, store: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidManagedJsonError(store, "not valid JSON");
  }
  if (!isPlainObject(value)) throw new InvalidManagedJsonError(store, "root must be an object");
  if (value.version !== 1) {
    if (typeof value.version === "number" && value.version > 1) {
      throw new UnsupportedManagedJsonVersionError(store, value.version);
    }
    throw new InvalidManagedJsonError(store, "schema version must be 1");
  }
  return value;
}

/** Move an invalid v1 store aside with its original bytes intact. */
async function quarantineInvalid(
  file: string,
  logger: AppLog = nullLog,
  now: Date = new Date(),
): Promise<string> {
  const dir = path.dirname(file);
  const stem = path.parse(file).name;
  const quarantined = path.join(dir, `${stem}-${defaultSessionTimestamp(now)}.invalid`);
  // not recorded: a move-aside of an already-unreadable managed file, not a managed-text write. The
  // subsequent fresh save through writeManagedJson is what records the recovered-to-defaults content.
  await rename(file, quarantined);
  logger.warn("quarantined a corrupt managed file; falling back to defaults", {
    original: file,
    quarantined,
  });
  return quarantined;
}

/** A load's parsed value plus where a corrupt original was set aside (null when the file was fine or
 *  absent). Each load reports its own outcome to its caller — there is no shared journal, so a
 *  reporting surface can never drain empty because it ran before the loads, and an unreported
 *  outcome is visible in the caller's code rather than rotting in a global. */
export interface ManagedJsonLoad<T> {
  value: T;
  quarantinedTo: string | null;
  missing: boolean;
}

/** Load without ever returning defaults while corrupt bytes remain at the live path. */
export async function loadManagedJson<T>(
  file: string,
  parse: (text: string) => T,
  onDefault: () => T,
  logger: AppLog = nullLog,
): Promise<ManagedJsonLoad<T>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { value: onDefault(), quarantinedTo: null, missing: true };
    }
    throw err;
  }
  try {
    return { value: parse(text), quarantinedTo: null, missing: false };
  } catch (err) {
    if (!(err instanceof InvalidManagedJsonError)) throw err;
    // Quarantine is outside the read catch. Rename failure propagates and leaves
    // the invalid live bytes untouched.
    const quarantinedTo = await quarantineInvalid(file, logger);
    return { value: onDefault(), quarantinedTo, missing: false };
  }
}

/**
 * The single managed-text atomic-write choke point, shared by config.json (settings.ts), layout.json
 * (layout.ts), and queue.json (persist.ts) — one shape, and one home for the data-backup hook. A
 * managed-text write that bypasses this helper is a silent backup gap; there is deliberately no
 * second atomic-write path in the app.
 *
 * Writes `text` to a same-directory temp named `<stem>-<nanoid>.tmp`, then atomically renames it
 * over `file` (storage-path conventions). Throws on failure; the caller logs it.
 *
 * The data-backup record fires strictly AFTER the rename lands, from the same `bytes` buffer just
 * written — never before the rename (a backup of a save that never happened) and never a re-read
 * (which could capture a concurrent writer's content). Best-effort: record() swallows its own
 * failures and never breaks the save (data-backup conventions).
 */
export async function writeManagedJson(file: string, text: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const bytes = Buffer.from(text, "utf8");
  const tmp = path.join(dir, `${path.parse(file).name}-${nanoid()}.tmp`);
  await writeFile(tmp, bytes);
  await rename(tmp, file);
  record(file, bytes);
}
