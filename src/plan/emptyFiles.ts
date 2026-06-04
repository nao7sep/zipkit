/**
 * Empty-file skip (§4 pass 3, §10.9). Under `emptyFiles: "skip"`, zero-byte
 * files are dropped. This is selection, not a portability defect, so it emits
 * no finding — just an exclusion. Runs before the empty-directory prune so a
 * directory left empty by skipped files can be pruned in turn.
 */

import type { ArchivePolicy } from "../types.js";
import type { WorkItem } from "./workItem.js";

export function applyEmptyFiles(items: WorkItem[], policy: ArchivePolicy): void {
  if (policy.emptyFiles !== "skip") return;
  for (const item of items) {
    if (item.excluded || item.type !== "file") continue;
    if (item.scan.size === 0) {
      item.excluded = true;
      item.excludeReason = "empty file skipped";
      item.emitExplicit = false;
    }
  }
}
