/**
 * Empty-directory handling (§4 pass 5, §10.9), bottom-up by construction. A ZIP
 * is entry-based: a non-empty directory is implied by its files and needs no
 * entry, so only directories with no content survive the question.
 *
 * A directory is *occupied* when it has a content file descendant; under
 * `recursive` (default) a zero-byte file is not content, under `strict` it is.
 * An unoccupied directory is empty. `prune` drops empty directories entirely;
 * `keep` preserves them with explicit entries — `strict` writes one entry per
 * empty directory, while `recursive` writes only the leaf empties (those with
 * no included child), letting extraction recreate the ancestors. A directory
 * already implied by an included child never gets a redundant entry.
 */

import { ancestorDirs, parentDir } from "../internal/path.js";
import type { ArchivePolicy } from "../types.js";
import type { WorkItem } from "./workItem.js";

export function applyEmptyDirs(items: WorkItem[], policy: ArchivePolicy): void {
  const occupied = new Set<string>();
  const hasIncludedChild = new Set<string>();

  for (const item of items) {
    if (item.excluded) continue;
    const parent = parentDir(item.archivePath);
    if (parent !== "") hasIncludedChild.add(parent);

    let isContent = false;
    if (item.type === "file") {
      isContent = policy.emptyDirDefinition === "strict" ? true : item.scan.size > 0;
    } else if (item.type === "symlink" && item.emitExplicit) {
      isContent = true;
    }
    if (!isContent) continue;
    for (const dir of ancestorDirs(item.archivePath)) occupied.add(dir);
  }

  for (const item of items) {
    if (item.excluded || item.type !== "dir") continue;

    if (occupied.has(item.archivePath)) {
      item.emitExplicit = false; // implied by its files
      continue;
    }

    if (policy.emptyDirs === "prune") {
      item.excluded = true;
      item.excludeReason = "empty directory pruned";
      item.emitExplicit = false;
    } else if (policy.emptyDirDefinition === "strict") {
      item.emitExplicit = true;
    } else {
      item.emitExplicit = !hasIncludedChild.has(item.archivePath);
    }
  }
}
