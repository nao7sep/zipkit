/** Shared safe loading and atomic writing for the GUI's managed JSON stores. */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { defaultSessionTimestamp } from "../../sdk/log/session.js";
import { record } from "./backupStore.js";
import { nullLog, type AppLog } from "./log.js";

/** True when `text` — already read from a managed JSON store's file — counts as corrupt for that
 *  store, per its own current corrupt-detection. */
export type CorruptionCheck = (text: string) => boolean;

/** The corrupt-detection shared by config.json and layout.json: the file must be valid JSON. A
 *  missing or wrong-shaped individual field beyond that is tolerated and filled from defaults by the
 *  store's own parse function, not treated as corruption. */
export function isInvalidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}

/** When `text` is corrupt per `isCorrupt`, rename `file` aside to its quarantine name (original bytes
 *  preserved), log one warning naming both paths, and return the quarantine path; null when `text` is
 *  not corrupt. `file` is moved, not copied, so the original path is free for the caller's next save
 *  immediately after. */
export async function quarantineIfCorrupt(
  file: string,
  text: string,
  isCorrupt: CorruptionCheck,
  logger: AppLog = nullLog,
  now: Date = new Date(),
): Promise<string | null> {
  if (!isCorrupt(text)) return null;
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

/**
 * How a store's loader treats a read that fails outright (not a corrupt-but-readable file):
 *
 * - `"default"` — an unreadable file degrades to the store's default value; the store's docstring
 *   promises "the defaults if there is no readable file". Fits the disposable preference stores
 *   (config.json, layout.json), where being unable to launch over a bad file is the worse failure.
 * - `"rethrow-non-enoent"` — an absent file (`ENOENT`) is the normal first-run case and yields the
 *   default, but any *other* read error propagates so the caller's session log records it instead of
 *   the store swallowing it. Fits the durable queue store, where a silent reset would lose real work.
 */
export type ReadErrorPolicy = "default" | "rethrow-non-enoent";

/** A load's parsed value plus where a corrupt original was set aside (null when the file was fine or
 *  absent). Each load reports its own outcome to its caller — there is no shared journal, so a
 *  reporting surface can never drain empty because it ran before the loads, and an unreported
 *  outcome is visible in the caller's code rather than rotting in a global. */
export interface ManagedJsonLoad<T> {
  value: T;
  quarantinedTo: string | null;
}

/** Load without ever returning defaults while corrupt bytes remain at the live path. */
export async function loadManagedJson<T>(
  file: string,
  isCorrupt: CorruptionCheck,
  parse: (text: string) => T,
  onDefault: () => T,
  readError: ReadErrorPolicy,
  logger: AppLog = nullLog,
): Promise<ManagedJsonLoad<T>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (readError === "default") return { value: onDefault(), quarantinedTo: null };
    // "rethrow-non-enoent": an absent file is the normal first-run case; anything else propagates.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { value: onDefault(), quarantinedTo: null };
    }
    throw err;
  }
  // Quarantine sits OUTSIDE the read's catch: a rename failure here must propagate, not fall through
  // to `onDefault()` while the corrupt bytes still sit at `file`.
  const quarantinedTo = await quarantineIfCorrupt(file, text, isCorrupt, logger);
  return { value: parse(text), quarantinedTo };
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
