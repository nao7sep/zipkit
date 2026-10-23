/**
 * Plan aggregation: the summary counters. The go/no-go `writable` verdict is
 * derived by the planner from `summary.errors` — severity alone gates, an
 * `error` blocks while a `warning` and an `info` never do. There is no override
 * for the error tier; a caller who wants an issue to block sets that issue to
 * `error` (for name rules, via the `names` policy; the pre-existing-output gate
 * raises an `output.exists` error finding).
 */

import type { WriteEntry } from "../internal/types.ts";
import type { Finding, PlanSummary } from "../types.ts";
import type { WorkItem } from "./workItem.ts";

/** The bytes an entry's content takes as on disk: a file's size, a stored
 *  link's target as UTF-8; a folder holds none. */
export function contentBytes(entry: WriteEntry): number {
  if (entry.type === "file") return entry.size;
  if (entry.type === "symlink") return Buffer.byteLength(entry.linkTarget ?? "", "utf8");
  return 0;
}

/** The summary of a plan's entries and findings. Built by the planner, and
 *  rebuilt by the writer from a plan it is handed, so both count alike. */
export function buildSummary(
  items: readonly Pick<WorkItem, "excluded" | "archivePath" | "originalPath">[],
  findings: readonly Pick<Finding, "severity">[],
  zip64: boolean,
  writeEntries: readonly WriteEntry[],
): PlanSummary {
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
    sourceBytes: writeEntries.reduce((sum, entry) => sum + contentBytes(entry), 0),
  };
}
