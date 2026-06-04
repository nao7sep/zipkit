/**
 * Collision detection (pass 7). The resolved tree — files and
 * directories — is case-folded on post-fix names. Distinct sources that fold
 * to the same path collide on a case-insensitive filesystem. An exact post-fix
 * match (often substitution-induced) is `collision.post-fix`; a case-only
 * difference is `collision.case`. Both are errors: ZipKit does not auto-rename,
 * because choosing which file to rename is the ambiguous resolution that
 * defines the error tier. The finding is attached to every entry in the
 * colliding group.
 */

import { finding } from "../registry.js";
import type { WorkItem } from "./workItem.js";

/**
 * @param reserved Archive paths the writer will inject after planning (the
 *   inside-metadata file). A real entry that folds to one would produce a
 *   duplicate ZIP entry — the same ambiguous, no-safe-auto-resolution case as a
 *   source-side collision — so it is reported here as an error, which also lets
 *   the dry run predict it.
 */
export function applyCollision(items: WorkItem[], reserved: readonly string[] = []): void {
  const groups = new Map<string, WorkItem[]>();
  for (const item of items) {
    if (item.excluded) continue;
    const fold = item.archivePath.toLowerCase();
    const group = groups.get(fold);
    if (group) group.push(item);
    else groups.set(fold, [item]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const distinctPaths = new Set(group.map((i) => i.archivePath));
    const rule = distinctPaths.size === 1 ? "collision.post-fix" : "collision.case";
    const message =
      rule === "collision.post-fix"
        ? "distinct sources resolve to the same archive path"
        : "distinct sources differ only by case and collide on case-insensitive filesystems";
    for (const item of group) {
      item.findings.push(finding(rule, item.archivePath, message));
    }
  }

  for (const name of reserved) {
    const group = groups.get(name.toLowerCase());
    if (!group) continue;
    for (const item of group) {
      item.findings.push(
        finding(
          "collision.post-fix",
          item.archivePath,
          `archive path collides with the reserved metadata file name "${name}"`,
        ),
      );
    }
  }
}
