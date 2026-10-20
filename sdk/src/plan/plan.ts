/**
 * The pure planning pipeline — the heart of ZipKit. Given the scan bundle
 * and a resolved policy, it runs every rule pass in load-bearing order and
 * returns a `Plan`. No I/O: the scan edge has already gathered the entries, the
 * resolved output, and its existence, so the dry run and the actual run share
 * this exact function and are faithful by construction.
 *
 * The order matters: paths are rooted before selection so the matcher sees a
 * clean path; names are fixed before collision so substitution-induced clashes
 * are caught; empty files are skipped before empty directories are pruned. The
 * writer's instructions are computed alongside the public entries and carried
 * on the plan as plain data (see `instructions.ts`).
 */

import { matcherFor } from "../filter/match.ts";
import { toInstructions } from "../internal/instructions.ts";
import type { ScanResult } from "../internal/types.ts";
import { finding } from "../registry.ts";
import type { ArchivePolicy, Finding, PlanData } from "../types.ts";
import { applyCollision } from "./collision.ts";
import { applyCompression } from "./compression.ts";
import { applyDedup } from "./dedup.ts";
import { applyEmptyDirs } from "./emptyDirs.ts";
import { applyEmptyFiles } from "./emptyFiles.ts";
import { applyFilter } from "./filterPass.ts";
import { applyNameFix, nameMessage } from "./nameFix.ts";
import { applyPathFix, windowsPathBudget } from "./pathFix.ts";
import { buildSummary } from "./summary.ts";
import { applySymlinks } from "./symlinks.ts";
import { applyTimestamps } from "./timestamps.ts";
import { excludedRecords } from "../write/manifest.ts";
import { planNeedsZip64, type ManifestContent } from "./zip64.ts";
import { buildWorkItems, buildWriteEntries, toPlannedEntry } from "./workItem.ts";

export function planArchive(scan: ScanResult, policy: ArchivePolicy): PlanData {
  const matcher = matcherFor(policy);
  // In path order, a folder before what it holds, rather than the order the
  // scan's concurrent stats happened to finish: the same tree always plans,
  // writes and records its entries in the same order.
  const items = buildWorkItems(scan).sort((a, b) => comparePaths(a.archivePath, b.archivePath));

  applyPathFix(items, windowsPathBudget(scan.output));
  applyFilter(items, matcher);
  applySymlinks(items, policy);
  applyEmptyFiles(items, policy);
  applyNameFix(items, policy);
  applyEmptyDirs(items, policy);
  applyDedup(items);
  // The writer injects the embedded manifest file at the archive root after
  // planning; reserve its name so a real entry that would collide with it is
  // caught here (and predicted by the dry run) rather than silently producing a
  // duplicate ZIP entry.
  const reserved = policy.manifest !== false ? [policy.manifest.name] : [];
  applyCollision(items, reserved);
  applyCompression(items, policy);
  applyTimestamps(items, scan.timeZone);

  const writeEntries = buildWriteEntries(items);

  const globalFindings: Finding[] = [];
  // The output pre-existing without an authorized overwrite blocks the write —
  // recorded as an error finding so it surfaces with a reason and so `writable`
  // derives from one place (the findings).
  // The archive's own name, reported against the name it would have had.
  for (const issue of scan.outputNaming.issues) {
    globalFindings.push(finding(issue.rule, scan.outputNaming.before, `archive name: ${nameMessage(issue.rule, issue.applied)}`, {
      severity: issue.severity,
      ...(issue.applied ? { fix: { kind: "rename" as const, to: scan.output } } : {}),
    }));
  }
  if (scan.outputExists && !scan.overwrite) globalFindings.push(outputExists(scan.output));

  const entries = items.map(toPlannedEntry);
  const findings: Finding[] = [];
  for (const item of items) {
    for (const f of item.findings) findings.push(f);
  }
  for (const f of globalFindings) findings.push(f);

  // The Zip64 verdict includes the manifest file the writer injects, sized from
  // its real content — the written entries, the dropped ones, and every finding —
  // so the dry run's `summary.zip64` matches what the write will emit.
  const content: ManifestContent = { entries: writeEntries, excluded: excludedRecords({ entries }), findings };
  if (scan.comment !== undefined) content.comment = scan.comment;
  const zip64 = planNeedsZip64(content, policy);

  const summary = buildSummary(items, findings, zip64, writeEntries);
  const writable = summary.errors === 0;

  const plan: PlanData = {
    mode: "plan",
    output: scan.output,
    writable,
    summary,
    findings,
    entries,
    instructions: toInstructions({
      output: scan.output,
      writable,
      zip64,
      writeEntries,
      policy,
      overwrite: scan.overwrite,
      timeZone: scan.timeZone,
      comment: scan.comment,
    }),
  };
  return plan;
}

/** The finding that blocks a plan, or a write that finds its name taken,
 *  because the output exists and replacing it was not authorized. */
export function outputExists(output: string): Finding {
  return finding("output.exists", output, "output archive already exists; authorize overwrite to replace it");
}

/** Paths compared segment by segment, by code unit, so `a` comes before
 *  `a/b` and `a/b` before `a-b`. */
function comparePaths(a: string, b: string): number {
  const left = a.split("/"), right = b.split("/");
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  }
  return left.length - right.length;
}
