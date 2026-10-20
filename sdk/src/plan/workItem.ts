/**
 * The mutable unit the planning pipeline threads through its passes, and the
 * conversions to the public {@link PlannedEntry} and the internal
 * {@link WriteEntry}. A work item starts as a raw scan entry and accumulates
 * resolved name, exclusion state, method, findings, and name fixes as the
 * passes run. The public entry omits the absolute source path; the write entry
 * keeps it for the plan's instructions.
 */

import { finding } from "../registry.ts";
import type { NameFix, ScanEntry, ScanResult, SkipKind, WriteEntry } from "../internal/types.ts";
import type { ExcludeCode, ExcludedBy, Finding, PlannedEntry, UnsupportedKind } from "../types.ts";

export interface WorkItem {
  scan: ScanEntry;
  archivePath: string; // mutated by the path/name passes
  originalPath: string; // the pre-fix archive path
  type: "file" | "dir" | "symlink";
  excluded: boolean;
  excludeCode?: ExcludeCode;
  excludeReason?: string;
  unsupportedKind?: UnsupportedKind;
  excludedBy?: ExcludedBy;
  method: "store" | "deflate";
  /** Whether the writer emits an explicit ZIP entry (files, preserved
   *  symlinks, kept empty directories) versus leaving it implied by children. */
  emitExplicit: boolean;
  findings: Finding[];
  nameFixes: NameFix[];
}

/** What the plan says about each object the walk left out. */
const SKIP_MESSAGES: Record<SkipKind, string> = {
  socket: "socket left out: a ZIP archive cannot hold it",
  fifo: "named pipe (FIFO) left out: a ZIP archive cannot hold it",
  device: "device file left out: a ZIP archive cannot hold it",
  "broken-link": "symbolic link left out: its target does not exist",
  "external-link": "symbolic link left out: its target is outside the input",
  "unreadable-link": "symbolic link left out: its target cannot be read",
};

/** A scan entry for an item that has no stat of its own to carry. */
function placeholderScan(archivePath: string, sourcePath: string, diskPath: string, type: ScanEntry["type"]): ScanEntry {
  return {
    absolutePath: "",
    inputIndex: -1,
    archivePath,
    sourcePath,
    diskPath,
    type,
    size: 0,
    mtimeNs: 0n,
    atimeNs: 0n,
    ctimeNs: 0n,
    birthtimeNs: 0n,
    mode: 0,
  };
}

export function buildWorkItems(scan: ScanResult): WorkItem[] {
  const items: WorkItem[] = [];

  for (const dir of scan.prunedDirs) {
    if (dir.archivePath === "") continue;
    items.push({
      scan: placeholderScan(dir.archivePath, dir.archivePath, dir.diskPath, "dir"),
      archivePath: dir.archivePath,
      originalPath: dir.archivePath,
      type: "dir",
      excluded: true,
      excludeCode: "pattern",
      excludeReason: dir.reason,
      excludedBy: dir.excludedBy,
      method: "store",
      emitExplicit: false,
      findings: [finding("exclude.pattern", dir.archivePath, `excluded by ${dir.reason}`)],
      nameFixes: [],
    });
  }

  // Excluded like a pruned folder, so the plan and the manifest's excluded list
  // name every object the walk found but could not archive.
  for (const skipped of scan.skipped) {
    const type = skipped.kind.endsWith("-link") ? "symlink" : "file";
    const message = SKIP_MESSAGES[skipped.kind];
    items.push({
      scan: placeholderScan(skipped.archivePath, skipped.sourcePath, skipped.diskPath, type),
      archivePath: skipped.archivePath,
      originalPath: skipped.archivePath,
      type,
      excluded: true,
      excludeCode: "unsupported",
      excludeReason: message,
      unsupportedKind: skipped.kind,
      method: "store",
      emitExplicit: false,
      findings: [finding("entry.unsupported", skipped.archivePath, message)],
      nameFixes: [],
    });
  }

  const unlisted = new Set(scan.unlistedDirs);
  for (const entry of scan.entries) {
    if (entry.archivePath === "") continue; // the archive root itself is not an entry
    const findings =
      entry.type === "dir" && unlisted.has(entry.archivePath)
        ? [
            finding(
              "entry.unlisted",
              entry.archivePath,
              "folder could not be read: its contents are not in the archive",
            ),
          ]
        : [];
    items.push({
      scan: entry,
      archivePath: entry.archivePath,
      originalPath: entry.archivePath,
      type: entry.type,
      excluded: false,
      method: "store",
      emitExplicit: entry.type === "file",
      findings,
      nameFixes: [],
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
      diskPath: item.scan.diskPath,
      type,
      method: item.method,
      excluded: item.excluded,
      ...(item.excludeCode ? { excludeCode: item.excludeCode } : {}),
      excludeReason: item.excludeReason,
      ...(item.unsupportedKind ? { unsupportedKind: item.unsupportedKind } : {}),
      ...(item.excludedBy ? { excludedBy: item.excludedBy } : {}),
      nameFixes: item.nameFixes,
      findings: item.findings,
    };
  }
  return {
    archivePath: item.archivePath,
    originalPath: item.originalPath,
    diskPath: item.scan.diskPath,
    type,
    method: item.method,
    excluded: item.excluded,
    nameFixes: item.nameFixes,
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
      sourcePath: item.scan.sourcePath,
      type: item.type,
      method: item.method,
      absolutePath: item.scan.absolutePath,
      size: item.scan.size,
      mtimeNs: item.scan.mtimeNs,
      atimeNs: item.scan.atimeNs,
      ctimeNs: item.scan.ctimeNs,
      birthtimeNs: item.scan.birthtimeNs,
      mode: item.scan.mode,
      nameFixes: item.nameFixes,
    };
    if (item.scan.linkTarget !== undefined) entry.linkTarget = item.scan.linkTarget;
    out.push(entry);
  }
  return out;
}
