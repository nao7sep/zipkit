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

import { matcherFor } from "../filter/match.ts";
import { attachInternals } from "../internal/carrier.ts";
import type { ScanResult, Unlogged } from "../internal/types.ts";
import { finding } from "../registry.ts";
import type { ArchivePolicy, CreateData, Finding } from "../types.ts";

/** The `mode:"plan"` member of {@link CreateData} — the dry-run payload and the
 *  writer's input. The carrier (writer instructions) rides on it out of band.
 *  Logging-agnostic: the `log` path is stamped by the SDK boundary, not here. */
type PlanData = Unlogged<Extract<CreateData, { mode: "plan" }>>;
import { applyCollision } from "./collision.ts";
import { applyCompression } from "./compression.ts";
import { applyDedup } from "./dedup.ts";
import { applyEmptyDirs } from "./emptyDirs.ts";
import { applyEmptyFiles } from "./emptyFiles.ts";
import { applyFilter } from "./filterPass.ts";
import { applyNameFix } from "./nameFix.ts";
import { applyPathFix } from "./pathFix.ts";
import { buildSummary } from "./summary.ts";
import { applySymlinks } from "./symlinks.ts";
import { applyTimestamps } from "./timestamps.ts";
import { planNeedsZip64, type MetadataContent } from "./zip64.ts";
import { buildWorkItems, buildWriteEntries, toPlannedEntry } from "./workItem.ts";

export function planArchive(scan: ScanResult, policy: ArchivePolicy): PlanData {
  const matcher = matcherFor(policy);
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
  applyCollision(items, reserved);
  applyCompression(items, policy);
  applyTimestamps(items, scan.timeZone);

  const writeEntries = buildWriteEntries(items);

  const globalFindings: Finding[] = [];
  // The output pre-existing without an authorized overwrite blocks the write —
  // recorded as an error finding so it surfaces with a reason and so `writable`
  // derives from one place (the findings), never silently diverging from `ok`.
  if (scan.outputExists && !scan.overwrite) {
    globalFindings.push(
      finding("output.exists", scan.output, "output archive already exists; authorize overwrite to replace it"),
    );
  }

  const entries = items.map(toPlannedEntry);
  const findings: Finding[] = [];
  for (const item of items) {
    for (const f of item.findings) findings.push(f);
  }
  for (const f of globalFindings) findings.push(f);

  // The Zip64 verdict includes the metadata file the writer injects, sized from
  // its real content — the written entries, the dropped ones, and every finding —
  // so the dry run's `summary.zip64` matches what the write will emit.
  const excluded = items
    .filter((item) => item.excluded)
    .map((item) => {
      const record: MetadataContent["excluded"][number] = {
        archivePath: item.archivePath,
        originalPath: item.originalPath,
      };
      if (item.excludeReason !== undefined) record.reason = item.excludeReason;
      return record;
    });
  const content: MetadataContent = { entries: writeEntries, excluded, findings };
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
  };
  attachInternals(plan, {
    writeEntries,
    policy,
    overwrite: scan.overwrite,
    timeZone: scan.timeZone,
    comment: scan.comment,
  });
  return plan;
}
