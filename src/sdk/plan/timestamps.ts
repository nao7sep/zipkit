/**
 * Timestamp policy (pass 9). The DOS time field can represent only
 * 1980 through 2107; a modification time below that range raises
 * `time.pre-1980`, and one above it raises `time.post-2107`. Both are clamped
 * by the writer (to the DOS minimum or maximum respectively); this pass only
 * flags the defect, symmetrically at both bounds.
 */

import { DOS_EPOCH_NS, DOS_LIMIT_NS } from "../internal/dosTime.js";
import { finding } from "../registry.js";
import type { WorkItem } from "./workItem.js";

export function applyTimestamps(items: WorkItem[]): void {
  for (const item of items) {
    if (item.excluded) continue;
    if (item.scan.mtimeNs < DOS_EPOCH_NS) {
      item.findings.push(
        finding(
          "time.pre-1980",
          item.archivePath,
          "modification time predates 1980 and is clamped to the DOS minimum",
        ),
      );
    } else if (item.scan.mtimeNs >= DOS_LIMIT_NS) {
      item.findings.push(
        finding(
          "time.post-2107",
          item.archivePath,
          "modification time is after 2107 and is clamped to the DOS maximum",
        ),
      );
    }
  }
}
