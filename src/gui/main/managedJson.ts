/** Shared safe loading and atomic writing for the GUI's managed JSON stores. */

import { lstat, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { record } from "./backupStore.js";
import { InvalidManagedJsonError, parseJsonObject } from "./managed-json-envelope.js";
import { writeManagedText, type ManagedWriteOptions } from "./managed-write.js";
import { nullLog, type AppLog } from "./log.js";
import { checkHeader, NewerFormatError, withHeader, type FileKind } from "./file-header.js";
import { APP_PACKAGE, APP_VERSION } from "../shared/identity.js";

export { InvalidManagedJsonError, isPlainObject } from "./managed-json-envelope.js";

/** A managed document's text: the file header, then the store's own keys. */
export function managedJsonText(kind: FileKind, body: Record<string, unknown>): string {
  return JSON.stringify(withHeader(kind, { name: APP_PACKAGE, version: APP_VERSION }, body), null, 2);
}

/** `yyyymmdd-hhmmss-utc`. Seconds are enough (timestamp conventions): one ZipKit instance runs at
 *  a time, and it sets a store aside at most once per launch. */
function setAsideStamp(now: Date): string {
  return now.toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "").replace("T", "-") + "-utc";
}

/** Move an unreadable store aside by one rename in its own directory, so its bytes and modified
 *  time stay as they were. An earlier copy under the same name is never replaced: the clash fails
 *  the load like any other failure to set aside, and the live bytes stay where they are. rename()
 *  itself would replace, so absence is checked first; with one instance, loading before any window
 *  exists, nothing in ZipKit can take the name in between. */
async function setAside(file: string, logger: AppLog, now: Date): Promise<string> {
  const target = path.join(path.dirname(file), `${path.parse(file).name}-${setAsideStamp(now)}.invalid`);
  const taken = await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (taken) throw Object.assign(new Error(`cannot set ${file} aside: ${target} already exists`), { code: "EEXIST" });
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
  /** The file names a later format version: it stays as it is, no save replaces it, and the
   *  defaults are used meanwhile. */
  newer: boolean;
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
 *  The document must be a JSON object whose header names `kind`; `parse` reads the store's own keys
 *  from it. A failure to set the file aside propagates, leaving the live bytes untouched. */
export async function loadManagedJson<T>(
  file: string,
  kind: FileKind,
  parse: (root: Record<string, unknown>) => T,
  onDefault: () => T,
  logger: AppLog = nullLog,
  options: ManagedJsonLoadOptions<T> = {},
): Promise<ManagedJsonLoad<T>> {
  let text: string;
  try {
    text = await readFile(file, { encoding: "utf8" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { value: onDefault(), quarantinedTo: null, missing: true, newer: false };
    }
    throw err;
  }
  const store = path.basename(file);
  let value: T;
  try {
    const root = parseJsonObject(text, store);
    checkHeader(root, kind, store);
    value = parse(root);
  } catch (err) {
    if (err instanceof NewerFormatError) {
      // Not damage: the file stays where it is, and the save admission refuses to replace it.
      logger.warn("managed file is from a newer format; leaving it as it is and using defaults", { file, error: err.message });
      return { value: onDefault(), quarantinedTo: null, missing: false, newer: true };
    }
    if (!(err instanceof InvalidManagedJsonError)) throw err;
    if (options.setAsideInvalid === false) {
      logger.warn("unreadable managed file; using defaults until the next save replaces it", { file, error: err.message });
      return { value: onDefault(), quarantinedTo: null, missing: false, newer: false };
    }
    // Setting aside is outside the parse catch, so its failure propagates.
    return { value: onDefault(), quarantinedTo: await setAside(file, logger, new Date()), missing: false, newer: false };
  }
  if (options.incomplete?.(value)) {
    return { value, quarantinedTo: await setAside(file, logger, new Date()), missing: false, newer: false };
  }
  return { value, quarantinedTo: null, missing: false, newer: false };
}

/**
 * The single managed-text atomic-write choke point, shared by config.json (settings.ts), layout.json
 * (layout.ts), and queue.json (persist.ts) — one shape, and one home for the data-backup hook; there
 * is deliberately no second atomic-write path in the app. Backup eligibility is explicit at the
 * owner (data-backup conventions): only a protected file passes `{ record: true }`, which today is
 * config.json alone. The job list is transient work and the layout is state, so neither records.
 *
 * Writes `text` through {@link writeManagedText} (./managed-write), the one atomic write, passing on
 * its `createAbsent` and `replaceUnreadable` options. It waits for the write's actual outcome, with
 * no timeout; each store's owner runs one save at a time ({@link newestSave}). Throws on failure;
 * the caller logs it.
 *
 * A requested data-backup record fires strictly AFTER the rename lands, from the same `bytes` buffer just
 * written — never before the rename (a backup of a save that never happened) and never a re-read.
 * Best-effort and not awaited: record() hands the bytes to the backups thread, swallows its own
 * failures and never breaks or delays the save (data-backup conventions).
 */
export async function writeManagedJson(
  file: string,
  text: string,
  options: ManagedWriteOptions & { record?: boolean } = {},
): Promise<void> {
  const bytes = Buffer.from(text, "utf8");
  if (await writeManagedText(file, bytes, options) && options.record === true) void record(file, bytes);
}

/** A store's own saves: one in flight, and only the newest value waiting behind it, so a burst of
 *  changes writes the file as few times as it can and never out of order. `save` resolves once the
 *  value it was given, or a newer one, is on disk, and rejects when the last write it waited for
 *  failed; a failed value stays waiting for the next `save` or `flush`. */
export function newestSave<T>(write: (value: T) => Promise<void>) {
  let waiting: { value: T } | null = null;
  let writing: { value: T } | null = null;
  let running: Promise<void> | null = null;
  // Called only with a value waiting, so it awaits a write before it can end, and `running` is
  // set before its `finally` clears it.
  async function drain(): Promise<void> {
    try {
      while (waiting) {
        writing = waiting;
        waiting = null;
        try {
          await write(writing.value);
        } catch (error) {
          if (waiting) continue;
          waiting = writing;
          throw error;
        } finally {
          writing = null;
        }
      }
    } finally {
      running = null;
    }
  }
  const flush = (): Promise<void> => {
    if (!running && waiting) running = drain();
    return running ?? Promise.resolve();
  };
  return {
    save(value: T): Promise<void> {
      waiting = { value };
      return flush();
    },
    flush,
    /** The newest value not yet on disk: one that waits, failed and was not replaced, or is
     *  being written. */
    unsaved: (): T | undefined => (waiting ?? writing)?.value,
    /** Forget a value that waits. */
    discard(): void { waiting = null; },
  };
}
