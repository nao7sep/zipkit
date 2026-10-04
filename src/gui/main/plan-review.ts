/**
 * Whether a fresh plan still shows what the user reviewed. Create re-plans
 * before it writes, and a queued job can run long after its Report was read;
 * when the new plan would show another Report, the job stops for review
 * instead of writing something the user did not see.
 *
 * The Report shows each entry's path in the archive and on disk, whether it is
 * excluded and why, every finding, and the output path. Those are compared;
 * sizes and times are not, so editing a file's content does not stop a Save
 * (before Trash, the recheck against the manifest covers content). Entry and
 * finding order is not compared either: the scan reports entries in the order
 * its concurrent stats finish.
 */

import type { PlanData } from "../shared/api.js";

function counts(items: Iterable<string>): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
  return map;
}

function sameMultiset(a: Iterable<string>, b: Iterable<string>): boolean {
  const left = counts(a);
  const right = counts(b);
  if (left.size !== right.size) return false;
  for (const [key, n] of left) if (right.get(key) !== n) return false;
  return true;
}

function entryKeys(plan: PlanData): string[] {
  return plan.entries.map((e) =>
    [e.archivePath, e.originalPath, e.type, e.excluded ? "excluded" : "", e.excludeReason ?? ""].join("\0"),
  );
}

function findingKeys(plan: PlanData): string[] {
  return plan.findings.map((f) => [f.rule, f.severity, f.path, f.message, f.fix?.to ?? ""].join("\0"));
}

export function reportChanged(reviewed: PlanData, fresh: PlanData): boolean {
  return (
    reviewed.output !== fresh.output ||
    !sameMultiset(entryKeys(reviewed), entryKeys(fresh)) ||
    !sameMultiset(findingKeys(reviewed), findingKeys(fresh))
  );
}
