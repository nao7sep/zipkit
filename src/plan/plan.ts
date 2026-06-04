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
 * writer's instructions are computed alongside the public entries and attached
 * to the plan out of band (see `carrier.ts`).
 */

import { buildMatcher } from "../filter/match.js";
import { attachInternals } from "../internal/carrier.js";
import type { ScanResult } from "../internal/types.js";
import type { ArchivePolicy, Finding, Plan } from "../types.js";
import { applyCollision } from "./collision.js";
import { applyCompression } from "./compression.js";
import { applyDedup } from "./dedup.js";
import { applyEmptyDirs } from "./emptyDirs.js";
import { applyEmptyFiles } from "./emptyFiles.js";
import { applyFilter } from "./filterPass.js";
import { applyNameFix } from "./nameFix.js";
import { applyPathFix } from "./pathFix.js";
import { buildSummary, computeWritable } from "./summary.js";
import { applySymlinks } from "./symlinks.js";
import { applyTimestamps } from "./timestamps.js";
import { applyZip64 } from "./zip64.js";
import { buildWorkItems, buildWriteEntries, toPlannedEntry } from "./workItem.js";

export function planArchive(scan: ScanResult, policy: ArchivePolicy): Plan {
  const matcher = buildMatcher(policy.filters, policy.junk === "builtin");
  const items = buildWorkItems(scan);

  applyPathFix(items);
  applyFilter(items, matcher);
  applySymlinks(items, policy);
  applyEmptyFiles(items, policy);
  applyNameFix(items, policy);
  applyEmptyDirs(items, policy);
  applyDedup(items);
  // The writer injects the embedded metadata file at the archive root after
  // planning; reserve its name so a real entry that would collide with it is
  // caught here (and predicted by the dry run) rather than silently producing a
  // duplicate ZIP entry.
  const reserved = policy.metadata !== false ? [policy.metadata.name] : [];
  applyCollision(items, policy.collisionCase, reserved);
  applyCompression(items, policy);
  applyTimestamps(items);

  const writeEntries = buildWriteEntries(items);
  const globalFindings: Finding[] = [];
  const zip64 = applyZip64(writeEntries, policy, scan.output, globalFindings);

  const entries = items.map(toPlannedEntry);
  const findings: Finding[] = [];
  for (const item of items) {
    for (const f of item.findings) findings.push(f);
  }
  for (const f of globalFindings) findings.push(f);

  const summary = buildSummary(items, findings, zip64);
  const writable = computeWritable(findings, scan.outputExists, scan.overwrite);

  const plan: Plan = {
    output: scan.output,
    outputExists: scan.outputExists,
    overwrite: scan.overwrite,
    writable,
    summary,
    entries,
    findings,
  };
  attachInternals(plan, { writeEntries, policy, comment: scan.comment });
  return plan;
}
