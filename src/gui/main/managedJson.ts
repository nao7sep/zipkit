/** Shared safe loading and atomic writing for the GUI's managed JSON stores. */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { record } from "./backupStore.js";
import { InvalidManagedJsonError, parseJsonObject } from "./managed-json-envelope.js";
import { writeManagedText, type ManagedWriteOptions } from "./managed-write.js";
import { nullLog, type AppLog } from "./log.js";
import { checkHeader, NewerFormatError, withHeader, type FileKind } from "./file-header.js";
import { APP_PACKAGE, APP_VERSION } from "../shared/identity.js";
import type { Refusal } from "./refusals.js";

export { InvalidManagedJsonError, isPlainObject } from "./managed-json-envelope.js";

/** A managed document's text: the file header, then the store's own keys. */
export function managedJsonText(kind: FileKind, body: Record<string, unknown>): string {
  return JSON.stringify(withHeader(kind, { name: APP_PACKAGE, version: APP_VERSION }, body), null, 2);
}


/** A load's parsed value, whether the file was absent, and why it was refused when it was. Each load
 *  reports its own outcome to its caller, which decides what a refusal does. */
export interface ManagedJsonLoad<T> {
  value: T;
  missing: boolean;
  /** The file was refused; `value` is then the defaults, and nothing replaces the file unless the
   *  store is disposable and its unreadable bytes may go. */
  refused: Refusal | null;
}

export interface ManagedJsonLoadOptions {
  /** True for a store whose unreadable bytes hold nothing worth keeping (layout.json): it falls back
   *  to its default with a log line and no refusal, and its next save replaces the bytes. A newer
   *  file is refused all the same. */
  disposable?: boolean;
}

/** Load at startup. The document must be a JSON object whose header names `kind`; `parse` reads the
 *  store's own keys from it, throwing {@link InvalidManagedJsonError} for what it cannot read. A
 *  refused file is reported and left exactly as it is. Read errors other than absence propagate. */
export async function loadManagedJson<T>(
  file: string,
  kind: FileKind,
  parse: (root: Record<string, unknown>) => T,
  onDefault: () => T,
  logger: AppLog = nullLog,
  options: ManagedJsonLoadOptions = {},
): Promise<ManagedJsonLoad<T>> {
  let text: string;
  try {
    text = await readFile(file, { encoding: "utf8" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { value: onDefault(), missing: true, refused: null };
    throw err;
  }
  const store = path.basename(file);
  try {
    const root = parseJsonObject(text, store);
    checkHeader(root, kind, store);
    return { value: parse(root), missing: false, refused: null };
  } catch (err) {
    if (err instanceof NewerFormatError) {
      logger.warn("managed file is from a newer format; refusing it", { file, error: err.message });
      return { value: onDefault(), missing: false, refused: { file, reason: "newer" } };
    }
    if (!(err instanceof InvalidManagedJsonError)) throw err;
    if (options.disposable === true) {
      logger.warn("unreadable managed file; using defaults until the next save replaces it", { file, error: err.message });
      return { value: onDefault(), missing: false, refused: null };
    }
    logger.warn("unreadable managed file; refusing it", { file, error: err.message });
    return { value: onDefault(), missing: false, refused: { file, reason: "unreadable" } };
  }
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
