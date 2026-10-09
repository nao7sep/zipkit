/** Shared safe loading and atomic writing for the GUI's managed JSON stores. */

import { lstat, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { record } from "./backupStore.js";
import { InvalidManagedJsonError, parseJsonObject } from "./managed-json-envelope.js";
import { MANAGED_IO_WAIT_MS, managedIO } from "./managed-io.js";
import { writeManagedText, type ManagedWriteOptions } from "./managed-write.js";
import { nullLog, type AppLog } from "./log.js";

export { InvalidManagedJsonError, isPlainObject } from "./managed-json-envelope.js";

/** A managed document's text: the store's own keys, with no format marker (a leftover
 *  `formatVersion` or 0.1.0 `version` key is ignored on load and dropped by the next save). */
export function managedJsonText(body: Record<string, unknown>): string {
  return JSON.stringify(body, null, 2);
}

/** `yyyymmdd-hhmmss-utc`. Seconds are enough (timestamp conventions): one ZipKit instance runs at
 *  a time, and it sets a store aside at most once per launch. */
function setAsideStamp(now: Date): string {
  return now.toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "").replace("T", "-") + "-utc";
}

/** Move an unreadable store aside by one rename in its own directory, so its bytes and modified
 *  time stay as they were. An earlier copy under the same name is never replaced: the clash fails
 *  the load like any other failure to set aside, and the live bytes stay where they are. rename()
 *  itself would replace, so absence is checked first; with one instance and each store's I/O in
 *  order, nothing in ZipKit can take the name in between. */
async function setAside(file: string, logger: AppLog, now: Date, signal?: AbortSignal): Promise<string> {
  const target = path.join(path.dirname(file), `${path.parse(file).name}-${setAsideStamp(now)}.invalid`);
  signal?.throwIfAborted();
  const taken = await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (taken) throw Object.assign(new Error(`cannot set ${file} aside: ${target} already exists`), { code: "EEXIST" });
  signal?.throwIfAborted();
  await rename(file, target);
  logger.warn("set aside an unreadable managed file", { original: file, setAside: target });
  return target;
}

/** A load's parsed value plus where an unreadable original was set aside (null when the file was
 *  fine or absent). Each load reports its own outcome to its caller — there is no shared journal, so
 *  a reporting surface can never drain empty because it ran before the loads, and an unreported
 *  outcome is visible in the caller's code rather than rotting in a global. */
export interface ManagedJsonLoad<T> {
  value: T;
  quarantinedTo: string | null;
  missing: boolean;
}

export interface ManagedJsonLoadOptions<T> {
  /** False for a store whose damaged bytes hold nothing worth keeping (layout.json): it falls back
   *  to its default with a log line, and its next save replaces the bytes. */
  setAsideInvalid?: boolean;
  /** Whether a parsed value left part of the file unread (a queue job that could not be read): the
   *  original is then set aside whole while the readable part is used. */
  incomplete?: (value: T) => boolean;
}

/** Load at startup without ever returning defaults while unreadable bytes remain at the live path.
 *  The document must be a JSON object; `parse` reads the store's own keys from it. A failure to set
 *  the file aside propagates, leaving the live bytes untouched. */
export async function loadManagedJson<T>(
  file: string,
  parse: (root: Record<string, unknown>) => T,
  onDefault: () => T,
  logger: AppLog = nullLog,
  options: ManagedJsonLoadOptions<T> = {},
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
    let value: T;
    try {
      value = parse(parseJsonObject(text, store));
    } catch (err) {
      if (!(err instanceof InvalidManagedJsonError)) throw err;
      if (options.setAsideInvalid === false) {
        logger.warn("unreadable managed file; using defaults until the next save replaces it", { file, error: err.message });
        return { value: onDefault(), quarantinedTo: null, missing: false };
      }
      // Setting aside is outside the parse catch, so its failure propagates.
      return { value: onDefault(), quarantinedTo: await setAside(file, logger, new Date(), signal), missing: false };
    }
    if (options.incomplete?.(value)) {
      return { value, quarantinedTo: await setAside(file, logger, new Date(), signal), missing: false };
    }
    return { value, quarantinedTo: null, missing: false };
  }, MANAGED_IO_WAIT_MS);
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
 * Writes `text` through {@link writeManagedText} (./managed-write), the one atomic write, passing on
 * its `createAbsent` and `replaceUnreadable` options. It waits for the write's actual outcome, with
 * no caller timeout; quit bounds its own wait. Throws on failure; the caller logs it.
 *
 * The data-backup record fires strictly AFTER the rename lands, from the same `bytes` buffer just
 * written — never before the rename (a backup of a save that never happened) and never a re-read
 * (which could capture a concurrent writer's content). Best-effort and not awaited: record() hands the
 * bytes to the backups thread, swallows its own failures and never breaks or delays the save
 * (data-backup conventions).
 */
export async function writeManagedJson(
  file: string,
  text: string | (() => string),
  options: ManagedWriteOptions & { record?: boolean; onWritten?: () => void } = {},
): Promise<void> {
  await managedIO(file, async (signal) => {
    // Field patches derive from the last physical commit, including a late one.
    const bytes = Buffer.from(typeof text === "function" ? text() : text, "utf8");
    if (await writeManagedText(file, bytes, signal, options) && options.record !== false) void record(file, bytes);
    options.onWritten?.();
  });
}
