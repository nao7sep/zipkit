/**
 * Selection (§4 pass 2). Each surviving entry is run through the ordered
 * matcher; the first matching rule decides. An exclude marks the entry and, for
 * a junk-preset rule, emits the corresponding `macos.junk`/`windows.junk` info
 * finding. An include or no match leaves the entry in. Directory subtrees that
 * a junk or user rule excluded were already pruned by the walk and arrive as
 * pre-excluded items, so they are skipped here.
 */

import { finding } from "../registry.js";
import type { FilterMatcher } from "../filter/match.js";
import type { WorkItem } from "./workItem.js";

export function applyFilter(items: WorkItem[], matcher: FilterMatcher): void {
  for (const item of items) {
    if (item.excluded) continue;
    const rule = matcher.match(item.archivePath, item.type === "dir");
    if (!rule || rule.action === "include") continue;

    item.excluded = true;
    item.excludeReason = rule.describe;
    item.emitExplicit = false;
    if (rule.junkRule) {
      item.findings.push(
        finding(rule.junkRule, item.archivePath, "excluded by the junk preset"),
      );
    }
  }
}
