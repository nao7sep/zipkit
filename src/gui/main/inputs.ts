/**
 * Classify input paths by what they are on disk — a directory, a file, missing,
 * or something else. This is GUI/main plumbing for the job-management UX (the job
 * label's dir/file counts, the input-CRUD list, gating "move originals to Trash"),
 * not ZIP-codec concern, so it lives here rather than in the SDK. The classifying
 * is pure given a stat function, so it unit-tests with a fake; the real edge uses
 * `node:fs`. A missing path is reported (never dropped) so it can be surfaced.
 */

import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { InputEntry, PathKind } from "../shared/queue.js";

/** Map a single stat outcome to a kind. `null` means the path could not be
 *  stat'd as existing (ENOENT or any other access error) → "nonexistent". */
export function kindFromStat(stats: Stats | null): PathKind {
  if (stats === null) return "nonexistent";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

/** Classify each path, preserving order. Takes the stat function so the ordering
 *  and mapping logic is testable without touching the real filesystem. */
export async function classifyPathsWith(
  paths: string[],
  statFn: (p: string) => Promise<Stats | null>,
): Promise<InputEntry[]> {
  return Promise.all(
    paths.map(async (path) => ({ path, kind: kindFromStat(await statFn(path)) })),
  );
}

/** The real classifier: stat each path on disk, treating any stat failure as a
 *  missing path rather than throwing (a vanished input must still appear). */
export function classifyPaths(paths: string[]): Promise<InputEntry[]> {
  return classifyPathsWith(paths, async (p) => {
    try {
      return await stat(p);
    } catch {
      return null;
    }
  });
}
