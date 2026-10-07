/** Shared safe loading and atomic writing for the GUI's managed JSON stores. */

import { copyFile, link, readFile, stat, unlink, utimes } from "node:fs/promises";
import { constants } from "node:fs";
import { nanoid } from "nanoid";
import path from "node:path";
import { defaultSessionTimestamp } from "../../sdk/log/session.js";
import { record } from "./backupStore.js";
import { InvalidManagedJsonError, parseJsonObject, storedFormatVersion } from "./managed-json-envelope.js";
import { NewerFormatError } from "./formatVersions.js";
import { managedIO } from "./managed-io.js";
import { writeManagedText } from "./managed-write.js";
import { nullLog, type AppLog } from "./log.js";

export { InvalidManagedJsonError, isPlainObject } from "./managed-json-envelope.js";

/** A managed document's text: its format version first, then the store's own keys. */
export function managedJsonText(formatVersion: number, body: Record<string, unknown>): string {
  return JSON.stringify({ formatVersion, ...body }, null, 2);
}

/** Move an invalid store aside with its original bytes intact. */
async function quarantineInvalid(
  file: string,
  logger: AppLog = nullLog,
  now: Date = new Date(),
  signal?: AbortSignal,
): Promise<string> {
  const dir = path.dirname(file);
  const stem = path.parse(file).name;
  const stamp = defaultSessionTimestamp(now);
  let quarantined = path.join(dir, `${stem}-${stamp}.invalid`);
  for (;;) {
    signal?.throwIfAborted();
    try {
      try {
        await link(file, quarantined);
      } catch (error) {
        if (!["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EACCES", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        const original = await stat(file);
        signal?.throwIfAborted();
        await copyFile(file, quarantined, constants.COPYFILE_EXCL);
        await utimes(quarantined, original.atime, original.mtime);
      }
      // The exclusive destination now holds the recoverable original. A failed
      // source removal propagates; defaults never overwrite the live bytes.
      await unlink(file);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      quarantined = path.join(dir, `${stem}-${stamp}-${nanoid()}.invalid`);
    }
  }
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

/** Load without ever returning defaults while corrupt bytes remain at the live path. The
 *  document's envelope (JSON object, format version) is checked here for every store; `parse`
 *  reads the store's own keys from the root object. A newer format propagates untouched. */
export async function loadManagedJson<T>(
  file: string,
  formatVersion: number,
  parse: (root: Record<string, unknown>) => T,
  onDefault: () => T,
  logger: AppLog = nullLog,
): Promise<ManagedJsonLoad<T>> {
  return managedIO(file, async (signal) => {
    let text: string;
    try {
      text = await readFile(file, { encoding: "utf8", signal });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { value: onDefault(), quarantinedTo: null, missing: true };
      }
      throw err;
    }
    const store = path.basename(file);
    try {
      const root = parseJsonObject(text, store);
      const found = storedFormatVersion(root, store);
      if (found > formatVersion) throw new NewerFormatError(file, found, formatVersion);
      return { value: parse(root), quarantinedTo: null, missing: false };
    } catch (err) {
      if (!(err instanceof InvalidManagedJsonError)) throw err;
      // Quarantine is outside the read catch. Publication failure propagates and leaves
      // the invalid live bytes untouched.
      const quarantinedTo = await quarantineInvalid(file, logger, new Date(), signal);
      return { value: onDefault(), quarantinedTo, missing: false };
    }
  });
}

/**
 * The single managed-text atomic-write choke point, shared by config.json (settings.ts), layout.json
 * (layout.ts), and queue.json (persist.ts) — one shape, and one home for the data-backup hook. A
 * managed-text write that bypasses this helper is a silent backup gap; there is deliberately no
 * second atomic-write path in the app. Volatile state that is state and nothing else (layout.json)
 * passes `{ record: false }` to skip the backup record while keeping the same atomic write. The one
 * save without a record is the queue's at the end of a Windows session (persist.ts), which the
 * session leaves no time to record.
 *
 * Writes `text` through {@link writeManagedText} (./managed-write), the one atomic write. Throws on
 * failure; the caller logs it.
 *
 * The data-backup record fires strictly AFTER the rename lands, from the same `bytes` buffer just
 * written — never before the rename (a backup of a save that never happened) and never a re-read
 * (which could capture a concurrent writer's content). Best-effort and not awaited: record() hands the
 * bytes to the backups thread, swallows its own failures and never breaks or delays the save
 * (data-backup conventions).
 */
export async function writeManagedJson(file: string, text: string | (() => string), options: { record?: boolean; onWritten?: () => void } = {}): Promise<void> {
  await managedIO(file, async (signal) => {
    // Field patches derive from the last physical commit, including a late one.
    const bytes = Buffer.from(typeof text === "function" ? text() : text, "utf8");
    if (await writeManagedText(file, bytes, signal) && options.record !== false) void record(file, bytes);
    options.onWritten?.();
  });
}
