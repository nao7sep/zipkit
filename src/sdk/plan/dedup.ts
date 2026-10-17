/**
 * Overlap dedup (§4 pass 6, §10.3). The same source reached through more than
 * one overlapping input resolves to the same archive path *and* the same
 * absolute source; that pair is collapsed to a single entry, recorded as the
 * `entry.duplicate` info finding. Distinct sources sharing a path are left for
 * the collision pass, which treats them as an error.
 */

import { finding } from "../registry.js";
import type { WorkItem } from "./workItem.js";

export function applyDedup(items: WorkItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.excluded) continue;
    const key = `${item.archivePath}\0${item.scan.absolutePath}`;
    if (seen.has(key)) {
      item.excluded = true;
      item.excludeCode = "duplicate";
      item.excludeReason = "duplicate of the same source";
      item.emitExplicit = false;
      item.findings.push(
        finding("entry.duplicate", item.archivePath, "same source reached through more than one input"),
      );
    } else {
      seen.add(key);
    }
  }
}
