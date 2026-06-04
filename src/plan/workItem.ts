/**
 * The mutable unit the planning pipeline threads through its passes, and the
 * conversions to the public {@link PlannedEntry} and the internal
 * {@link WriteEntry}. A work item starts as a raw scan entry and accumulates
 * resolved name, exclusion state, method, findings, and transformations as the
 * passes run. The public entry omits the absolute source path; the write entry
 * keeps it (carried out of band, never serialized).
 */

import { finding } from "../registry.js";
import type { ScanEntry, ScanResult, Transformation, WriteEntry } from "../internal/types.js";
import type { Finding, PlannedEntry } from "../types.js";

export interface WorkItem {
  scan: ScanEntry;
  archivePath: string; // mutated by the path/name passes
  originalPath: string; // the pre-fix archive path
  type: "file" | "dir" | "symlink";
  excluded: boolean;
  excludeReason?: string;
  method: "store" | "deflate";
  /** Whether the writer emits an explicit ZIP entry (files, preserved
   *  symlinks, kept empty directories) versus leaving it implied by children. */
  emitExplicit: boolean;
  findings: Finding[];
  transformations: Transformation[];
}

export function buildWorkItems(scan: ScanResult): WorkItem[] {
  const items: WorkItem[] = [];

  for (const dir of scan.prunedDirs) {
    if (dir.archivePath === "") continue;
    items.push({
      scan: {
        absolutePath: "",
        inputIndex: -1,
        archivePath: dir.archivePath,
        type: "dir",
        size: 0,
        mtimeNs: 0n,
        birthtimeNs: 0n,
        mode: 0,
      },
      archivePath: dir.archivePath,
      originalPath: dir.archivePath,
      type: "dir",
      excluded: true,
      excludeReason: dir.reason,
      method: "store",
      emitExplicit: false,
      findings: dir.rule
        ? [finding(dir.rule, dir.archivePath, `directory excluded by the junk preset`)]
        : [],
      transformations: [],
    });
  }

  for (const entry of scan.entries) {
    if (entry.archivePath === "") continue; // the archive root itself is not an entry
    items.push({
      scan: entry,
      archivePath: entry.archivePath,
      originalPath: entry.archivePath,
      type: entry.type,
      excluded: false,
      method: "store",
      emitExplicit: entry.type === "file",
      findings: [],
      transformations: [],
    });
  }

  return items;
}

export function toPlannedEntry(item: WorkItem): PlannedEntry {
  // A preserved symlink is stored as a regular entry; the public type is file.
  const type: "file" | "dir" = item.type === "dir" ? "dir" : "file";
  if (item.excludeReason !== undefined) {
    return {
      archivePath: item.archivePath,
      originalPath: item.originalPath,
      type,
      method: item.method,
      excluded: item.excluded,
      excludeReason: item.excludeReason,
      findings: item.findings,
    };
  }
  return {
    archivePath: item.archivePath,
    originalPath: item.originalPath,
    type,
    method: item.method,
    excluded: item.excluded,
    findings: item.findings,
  };
}

export function buildWriteEntries(items: WorkItem[]): WriteEntry[] {
  const out: WriteEntry[] = [];
  for (const item of items) {
    if (item.excluded || !item.emitExplicit) continue;
    const entry: WriteEntry = {
      archivePath: item.archivePath,
      originalPath: item.originalPath,
      type: item.type,
      method: item.method,
      absolutePath: item.scan.absolutePath,
      size: item.scan.size,
      mtimeNs: item.scan.mtimeNs,
      birthtimeNs: item.scan.birthtimeNs,
      mode: item.scan.mode,
      transformations: item.transformations,
    };
    if (item.scan.linkTarget !== undefined) entry.linkTarget = item.scan.linkTarget;
    out.push(entry);
  }
  return out;
}
