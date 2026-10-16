/**
 * Classify input paths by what they are on disk — a directory, a file, missing,
 * or something else. This is GUI/main plumbing for the job-management UX (the job
 * label's dir/file counts, the input-CRUD list, gating "move originals to Trash"),
 * not ZIP-codec concern, so it lives here rather than in the SDK. The classifying
 * is pure given a stat function, so it unit-tests with a fake; the real edge uses
 * the SDK's bounded volume. A missing path is reported (never dropped) so it can
 * be surfaced.
 */

import { ZipKitError, type Volume } from "../../sdk/index.js";
import { pathState } from "./path-state.js";
import type { InputEntry, PathKind } from "../shared/queue.js";

/** The part of a stat result the classifier reads. */
export interface KindStats {
  isDirectory(): boolean;
  isFile(): boolean;
}

/** Map a single stat outcome to a kind. `null` means the path could not be
 *  stat'd as existing (ENOENT or any other access error) → "nonexistent". */
export function kindFromStat(stats: KindStats | null): PathKind {
  if (stats === null) return "nonexistent";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

/** Classify each path, preserving order. Takes the stat function so the ordering
 *  and mapping logic is testable without touching the real filesystem. */
export async function classifyPathsWith(
  paths: string[],
  statFn: (p: string) => Promise<KindStats | null>,
): Promise<InputEntry[]> {
  return Promise.all(
    paths.map(async (path) => ({ path, kind: kindFromStat(await statFn(path)) })),
  );
}

/** The real classifier: stat each path on disk. A path that is not there is
 *  missing, unless the drive that holds it is not connected; one that cannot
 *  be read is out of reach — neither is ever taken for a deletion, and a
 *  vanished input still appears. A stalled volume rejects, and the caller
 *  keeps the previous classification. */
export async function classifyPaths(paths: string[], volume: Volume): Promise<InputEntry[]> {
  return Promise.all(paths.map(async (path): Promise<InputEntry> => {
    const state = await pathState(path, volume);
    if (state.kind === "gone") return { path, kind: "nonexistent" };
    if (state.kind === "unavailable") return { path, kind: "unavailable" };
    return { path, kind: kindFromStat(await volume.stat(path).catch((err: unknown) => {
      if (err instanceof ZipKitError) throw err;
      return null;
    })) };
  }));
}
