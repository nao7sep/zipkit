/**
 * Shared quarantine-then-reset for a present-but-corrupt managed JSON store: config.json (settings.ts),
 * layout.json (layout.ts), and queue.json (persist.ts). Storage-path conventions forbid the one path
 * those three loaders used to take — silently resetting to defaults *over* a corrupt file, so the very
 * next save overwrites the user's original bytes with no trace they ever existed. Quarantine instead:
 * rename the corrupt file aside (bytes preserved, not copied) to `<stem>-<ms-utc-stamp>.invalid` in the
 * same directory — the storage-path conventions' derived-filename grammar for a quarantine name — log
 * one warning naming both paths, and let the caller fall through to its own defaults. The millisecond
 * stamp reuses {@link defaultSessionTimestamp}, the same formatter the SDK's and the GUI's session logs
 * already use, rather than a fourth timestamp formatter.
 *
 * What counts as "corrupt" is store-specific — each store already enforces its own shape on load — so
 * it is supplied by the caller as `isCorrupt`; this module owns only the quarantine mechanics, once, for
 * all three stores. The backup index's own unreadable-index-resets-to-empty path is a different,
 * genuinely disposable cache and stays out of scope here (governed by the data-backup conventions).
 */

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
 *  preserved) and log one warning naming both paths. A no-op when `text` is not corrupt. `file` is
 *  moved, not copied, so the original path is free for the caller's next save immediately after. */
export async function quarantineIfCorrupt(
  file: string,
  text: string,
  isCorrupt: CorruptionCheck,
  logger: AppLog = nullLog,
  now: Date = new Date(),
): Promise<void> {
  if (!isCorrupt(text)) return;
  const dir = path.dirname(file);
  const stem = path.parse(file).name;
  const quarantined = path.join(dir, `${stem}-${defaultSessionTimestamp(now)}.invalid`);
  // not recorded: this is a move-aside of an already-unreadable managed file, not a managed-text write —
  // no new content is produced here, and the corrupt bytes are not a version to preserve in the history
  // (the store never captured them, so there is nothing to add). The subsequent fresh save through
  // writeManagedJson is what records the recovered-to-defaults content.
  await rename(file, quarantined);
  logger.warn("quarantined a corrupt managed file; falling back to defaults", {
    original: file,
    quarantined,
  });
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

/**
 * Load a managed JSON store the one correct way, shared by config.json (settings.ts), layout.json
 * (layout.ts), and queue.json (persist.ts) so all three take the identical shape rather than each
 * hand-rolling it. The single invariant this centralizes: the corrupt-file **quarantine runs OUTSIDE
 * the read's failure handling**, so a quarantine-rename failure (a transient lock, an AV hold, a
 * permission hiccup) propagates to the caller — it is never swallowed into "return defaults", which
 * would leave the corrupt bytes in place for the next save to overwrite, the silent-reset-over-a-
 * corrupt-file outcome the storage-path convention forbids.
 *
 * The default value is therefore returned in exactly two cases, never a third: the file is absent
 * (or, under `"default"`, otherwise unreadable), or its corrupt bytes were **successfully** moved
 * aside. While corrupt bytes remain on disk, no default is returned.
 *
 * @param file       the resolved store path (each store still owns its own path resolver).
 * @param isCorrupt  the store's own corrupt-detection over the read text.
 * @param parse      the store's pure parse of a readable, non-corrupt text into its value.
 * @param onDefault  the store's default value, used for an absent (or unreadable, per policy) file.
 * @param readError  how an outright read failure is treated (see {@link ReadErrorPolicy}).
 */
export async function loadManagedJson<T>(
  file: string,
  isCorrupt: CorruptionCheck,
  parse: (text: string) => T,
  onDefault: () => T,
  readError: ReadErrorPolicy,
  logger: AppLog = nullLog,
): Promise<T> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (readError === "default") return onDefault();
    // "rethrow-non-enoent": an absent file is the normal first-run case; anything else propagates.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return onDefault();
    throw err;
  }
  // Quarantine sits OUTSIDE the read's catch: a rename failure here must propagate, not fall through
  // to `onDefault()` while the corrupt bytes still sit at `file`.
  await quarantineIfCorrupt(file, text, isCorrupt, logger);
  return parse(text);
}

/**
 * The single managed-text atomic-write choke point, shared by config.json (settings.ts), layout.json
 * (layout.ts), and queue.json (persist.ts) so all three take the identical shape rather than each
 * hand-rolling the temp-then-rename — and, crucially, so the data-backup hook lives in exactly ONE
 * place. A managed-text write that bypasses this helper is a silent backup gap; there is deliberately
 * no second atomic-write path in the app.
 *
 * Writes `text` to a same-directory temp named `<stem>-<nanoid>.tmp` (the storage-path conventions'
 * derived-filename grammar — the nanoid guarantees two concurrent writers never share a temp), then
 * atomically renames it over `file`, so a crash mid-write cannot corrupt the target. Throws on failure;
 * the caller (an IPC handler, the queue's debounced save) logs it through the session log.
 *
 * **The data-backup record fires strictly AFTER the rename lands (data-backup conventions).** Recording
 * before the rename would risk a "backup of a save that never happened": if the rename then failed, the
 * history would hold a version that never reached disk. So: rename lands, *then* record the exact bytes
 * just written — the same `bytes` buffer already in hand, never a re-read of the file (which would risk
 * capturing a concurrent writer's content, not what this call wrote). The record is best-effort and
 * silent; it never throws back into this write and never affects the save's success (see backupStore).
 */
export async function writeManagedJson(file: string, text: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const bytes = Buffer.from(text, "utf8");
  const tmp = path.join(dir, `${path.parse(file).name}-${nanoid()}.tmp`);
  await writeFile(tmp, bytes);
  await rename(tmp, file);
  // After the rename: the file is exactly where it belongs, so record the bytes we just wrote. Best-
  // effort — record() catches, logs once, and swallows every failure, so a backup problem can never
  // break the save that already succeeded above.
  record(file, bytes);
}
