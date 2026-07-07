/**
 * Builders for synthetic scan data, so the pure planner can be tested over
 * table-driven entry arrays with no filesystem access.
 */

import type { ScanEntry, ScanResult } from "../../src/sdk/internal/types.js";
import type { WorkItem } from "../../src/sdk/plan/workItem.js";

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

/**
 * A single planning {@link WorkItem} in its post-build, pre-pass state, so the
 * individual rule passes can be driven directly instead of only through the
 * whole pipeline. `size`/`mtimeNs`/`absolutePath` feed the synthetic `scan`
 * (the fields the passes actually read — size for empty checks, mtime for the
 * DOS-range check, absolutePath for the dedup key); WorkItem fields can be
 * overridden directly, with the same defaults `buildWorkItems` assigns (a file
 * emits explicitly, a dir/symlink does not).
 */
export function workItem(
  over: Partial<Omit<WorkItem, "scan">> & {
    archivePath: string;
    size?: number;
    mtimeNs?: bigint;
    absolutePath?: string;
    scan?: ScanEntry;
  },
): WorkItem {
  const type = over.type ?? "file";
  const scan =
    over.scan ??
    scanEntry({
      archivePath: over.archivePath,
      type,
      ...(over.size !== undefined ? { size: over.size } : {}),
      ...(over.mtimeNs !== undefined ? { mtimeNs: over.mtimeNs } : {}),
      ...(over.absolutePath !== undefined ? { absolutePath: over.absolutePath } : {}),
    });
  const item: WorkItem = {
    scan,
    archivePath: over.archivePath,
    originalPath: over.originalPath ?? over.archivePath,
    type,
    excluded: over.excluded ?? false,
    method: over.method ?? "store",
    emitExplicit: over.emitExplicit ?? type === "file",
    findings: over.findings ?? [],
    transformations: over.transformations ?? [],
  };
  if (over.excludeReason !== undefined) item.excludeReason = over.excludeReason;
  return item;
}
