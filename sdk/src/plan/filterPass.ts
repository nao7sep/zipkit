/**
 * Selection (pass 2). Each surviving entry is run through the ordered
 * matcher; the first matching exclusion pattern excludes it with an
 * `exclude.pattern` info finding naming the pattern. No match leaves the entry
 * in (inclusive by default). Directory subtrees a pattern excluded were
 * already pruned by the walk and arrive as pre-excluded items, so they are
 * skipped here.
 */

import { finding } from "../registry.ts";
import type { FilterMatcher } from "../filter/match.ts";
import type { WorkItem } from "./workItem.ts";

export function applyFilter(items: WorkItem[], matcher: FilterMatcher): void {
  for (const item of items) {
    if (item.excluded) continue;
    const rule = matcher.match(item.archivePath, item.type === "dir");
    if (!rule) continue;

    item.excluded = true;
    item.excludeCode = "pattern";
    item.excludeReason = rule.describe;
    item.emitExplicit = false;
    item.findings.push(finding("exclude.pattern", item.archivePath, `excluded by ${rule.describe}`));
  }
}
