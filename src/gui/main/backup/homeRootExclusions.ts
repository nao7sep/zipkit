/**
 * The optimistic exclude list for the `~/.zipkit/` home root: everything under the root is backed up
 * except the entries here. Pure, so the "did we pick the right files?" decision is unit-testable.
 *
 * Captured like any durable file: `config.json` (settings, src/gui/main/settings.ts) and `queue.json`
 * (the resumable job queue — the user's own work, src/gui/main/persist.ts). Excluded:
 *
 * - `layout.json` — volatile pane geometry (window-chrome UI state). It changes on nearly every session
 *   and is harmless to lose, so capturing it would emit a near-worthless backup on almost every launch
 *   and defeat the skip-empty property (data-backup conventions, "Volatile UI state").
 * - `backups/` — the feature's own output; capturing it would recurse.
 * - `logs/` — recreatable per-launch session/SDK logs.
 * - the fleet always-exclude set: `*.tmp` (atomic-write temporaries), `*.invalid` (a quarantined
 *   corrupt managed file — src/gui/main/managedJson.ts — which must never re-enter an archive),
 *   `.DS_Store`, `Thumbs.db`.
 *
 * Paths are the forward-slash relative path under the root. Directory names are matched
 * case-insensitively so a `Logs/` or `Backups/` on a case-insensitive filesystem is still pruned.
 */
import { normalize } from "./archivePaths.js";

/** Home-root subtrees never descended into. */
const EXCLUDED_DIRS = ["logs", "backups"];

/** Fixed home-root files never captured. */
const EXCLUDED_FILES = ["layout.json"];

/** Basenames excluded anywhere in the tree (the fleet always-exclude noise files, matched lowercased). */
const EXCLUDED_BASENAMES = [".ds_store", "thumbs.db", "desktop.ini"];

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** True when a home-root file must not be backed up. */
export function isExcludedFile(relativePath: string): boolean {
  const path = normalize(relativePath);
  const lower = path.toLowerCase();
  if (lower.endsWith(".tmp")) return true;
  if (lower.endsWith(".invalid")) return true;
  if (EXCLUDED_FILES.includes(lower)) return true;
  if (EXCLUDED_BASENAMES.includes(basename(lower))) return true;
  return EXCLUDED_DIRS.some((dir) => lower === dir || lower.startsWith(`${dir}/`));
}

/** True when a home-root subdirectory should be pruned (not descended into) during the walk. */
export function isExcludedDir(relativeDirPath: string): boolean {
  return EXCLUDED_DIRS.includes(normalize(relativeDirPath).toLowerCase());
}
