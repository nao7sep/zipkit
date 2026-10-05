/**
 * Timestamp policy (pass 9). The DOS time field can represent only 1980
 * through 2107 in the wall clock of the zone it is rendered in; a modification
 * time below that range raises `time.pre-1980`, and one above it raises
 * `time.post-2107`. The writer clamps both, to the DOS minimum or maximum
 * respectively; this pass only flags the defect. Both judge the range through
 * `dosDateTime` in the same resolved zone, so the flag matches the clamp.
 */

import { dosDateTime } from "../internal/dosTime.js";
import { finding } from "../registry.js";
import type { WorkItem } from "./workItem.js";

export function applyTimestamps(items: WorkItem[], timeZone: string): void {
  for (const item of items) {
    if (item.excluded) continue;
    const { clamped } = dosDateTime(item.scan.mtimeNs, timeZone);
    if (clamped === "pre-1980") {
      item.findings.push(
        finding(
          "time.pre-1980",
          item.archivePath,
          "modification time predates 1980 and is clamped to the DOS minimum",
        ),
      );
    } else if (clamped === "post-2107") {
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
