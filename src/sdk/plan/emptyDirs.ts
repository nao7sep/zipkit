/**
 * Empty-directory handling (pass 5), bottom-up by construction.
 *
 * A directory is *occupied* when it has a content (non-empty) file descendant;
 * a zero-byte file is not content. An unoccupied directory is empty. `prune`
 * drops empty directories entirely; `keep` preserves them. Every directory that
 * stays, occupied or empty, is written as its own entry so its stored times
 * survive extraction.
 */

import { ancestorDirs } from "../internal/path.js";
import type { ArchivePolicy } from "../types.js";
import type { WorkItem } from "./workItem.js";

export function applyEmptyDirs(items: WorkItem[], policy: ArchivePolicy): void {
  const occupied = new Set<string>();

  for (const item of items) {
    if (item.excluded) continue;
    let isContent = false;
    if (item.type === "file") {
      isContent = item.scan.size > 0;
    } else if (item.type === "symlink" && item.emitExplicit) {
      isContent = true;
    }
    if (!isContent) continue;
    for (const dir of ancestorDirs(item.archivePath)) occupied.add(dir);
  }

  for (const item of items) {
    if (item.excluded || item.type !== "dir") continue;

    if (policy.emptyDirs === "prune" && !occupied.has(item.archivePath)) {
      item.excluded = true;
      item.excludeReason = "empty directory pruned";
      item.emitExplicit = false;
    } else {
      item.emitExplicit = true;
    }
  }
}
