/**
 * Builders for synthetic scan data, so the pure planner can be tested over
 * table-driven entry arrays with no filesystem access.
 */

import type { ScanEntry, ScanResult } from "../../src/sdk/internal/types.js";

/** 2020-01-01T00:00:00Z in nanoseconds — well after the 1980 DOS floor. */
export const Y2020_NS = 1_577_836_800_000_000_000n;

export function scanEntry(over: Partial<ScanEntry> & { archivePath: string }): ScanEntry {
  const entry: ScanEntry = {
    absolutePath: over.absolutePath ?? `/abs/${over.archivePath}`,
    inputIndex: over.inputIndex ?? 0,
    archivePath: over.archivePath,
    sourcePath: over.sourcePath ?? over.archivePath,
    type: over.type ?? "file",
    size: over.size ?? 10,
    mtimeNs: over.mtimeNs ?? Y2020_NS,
    atimeNs: over.atimeNs ?? Y2020_NS,
    ctimeNs: over.ctimeNs ?? Y2020_NS,
    birthtimeNs: over.birthtimeNs ?? Y2020_NS,
    mode: over.mode ?? 0o644,
  };
  if (over.linkTarget !== undefined) entry.linkTarget = over.linkTarget;
  return entry;
}

export function scanResult(entries: ScanEntry[], over: Partial<ScanResult> = {}): ScanResult {
  return {
    entries,
    prunedDirs: over.prunedDirs ?? [],
    output: over.output ?? "/tmp/zipkit-test/out.zip",
    outputExists: over.outputExists ?? false,
    overwrite: over.overwrite ?? false,
  };
}
