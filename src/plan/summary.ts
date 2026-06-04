/**
 * Plan aggregation: the summary counters and the go/no-go `writable` verdict.
 * `writable` is false when any error-tier finding is present, or when the output
 * archive already exists without an authorized overwrite. Severity alone gates —
 * an `error` blocks, a `warning` and an `info` never do. There is no override
 * for the error tier; a caller who wants an issue to block sets that issue to
 * `error` (for name rules, via the `names` policy).
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

export function computeWritable(
  findings: Finding[],
  outputExists: boolean,
  overwrite: boolean,
): boolean {
  for (const f of findings) {
    if (f.severity === "error") return false;
  }
  // The output archive pre-existing without an authorized overwrite blocks the
  // write, so a run never silently clobbers a file the user did not name.
  if (outputExists && !overwrite) return false;
  return true;
}
