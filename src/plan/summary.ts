/**
 * Plan aggregation: the summary counters and the go/no-go `writable` verdict.
 * `writable` is false when any error-tier finding is present, when strict
 * gating is on and any warning-tier finding is present, or when the output
 * already exists without an authorized overwrite. There is no override for the
 * error tier.
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
  strict: boolean,
  outputExists: boolean,
  overwrite: boolean,
): boolean {
  for (const f of findings) {
    if (f.severity === "error") return false;
    if (strict && f.severity === "warning") return false;
  }
  if (outputExists && !overwrite) return false;
  return true;
}
