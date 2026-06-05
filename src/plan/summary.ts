/**
 * Plan aggregation: the summary counters. The go/no-go `writable` verdict is
 * derived by the planner from `summary.errors` — severity alone gates, an
 * `error` blocks while a `warning` and an `info` never do. There is no override
 * for the error tier; a caller who wants an issue to block sets that issue to
 * `error` (for name rules, via the `names` policy; the pre-existing-output gate
 * raises an `output.exists` error finding).
 */

import type { Finding, PlanSummary } from "../types.js";
import type { WorkItem } from "./workItem.js";

export function buildSummary(items: WorkItem[], findings: Finding[], zip64: boolean): PlanSummary {
  let included = 0;
  let excluded = 0;
  let renamed = 0;
  for (const item of items) {
    if (item.excluded) {
      excluded++;
      continue;
    }
    included++;
    if (item.archivePath !== item.originalPath) renamed++;
  }

  let warnings = 0;
  let errors = 0;
  for (const f of findings) {
    if (f.severity === "warning") warnings++;
    else if (f.severity === "error") errors++;
  }

  return {
    total: items.length,
    included,
    excluded,
    renamed,
    warnings,
    errors,
    zip64,
  };
}
