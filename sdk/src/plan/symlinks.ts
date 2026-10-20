/**
 * Symlink policy for the entries the scan still reports as links.
 * Under `follow`, the scan already dereferenced the link into a regular entry,
 * so nothing of type `"symlink"` reaches here. Under `ignore` (default) the
 * link is excluded; under `preserve` it is stored as a Unix link entry — which
 * breaks the clean-byte guarantee and is extracted as a text file on Windows,
 * so a loud warning is emitted. Either way the link is a portability defect,
 * raised as `entry.symlink-ignored` or `entry.symlink-preserved`.
 */

import { finding } from "../registry.ts";
import type { ArchivePolicy } from "../types.ts";
import type { WorkItem } from "./workItem.ts";

export function applySymlinks(items: WorkItem[], policy: ArchivePolicy): void {
  for (const item of items) {
    if (item.excluded || item.type !== "symlink") continue;

    if (policy.symlinks === "preserve") {
      item.emitExplicit = true;
      item.method = "store";
      item.findings.push(
        finding(
          "entry.symlink-preserved",
          item.archivePath,
          "symlink preserved as a Unix link entry; Windows extracts it as a text file",
        ),
      );
    } else {
      item.excluded = true;
      item.excludeCode = "symlink";
      item.excludeReason = "symlink ignored";
      item.emitExplicit = false;
      item.findings.push(finding("entry.symlink-ignored", item.archivePath, "symlink ignored"));
    }
  }
}
