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

import { rename } from "node:fs/promises";
import path from "node:path";
import { defaultSessionTimestamp } from "../../sdk/log/session.js";
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
  await rename(file, quarantined);
  logger.warn("quarantined a corrupt managed file; falling back to defaults", {
    original: file,
    quarantined,
  });
}
