/**
 * Enumerate a stage's findings onto the one log/progress stream — the
 * convention's "count the successes, enumerate the failures" rule, realized
 * through the single event producer. Each finding becomes one `entry.flagged`
 * event at the level its severity maps to (`error → error`, `warning → warn`,
 * `info → info`), so the per-failure detail rides the same seam that already
 * feeds the per-session log and the `onProgress` hook.
 *
 * Both stages that produce findings route through here — the plan stage
 * (`src/zipkit.ts`) and the extract/validate stage (`src/extract/extract.ts`) —
 * so a CRC failure, a SHA mismatch, an unsafe path, or a portability defect is
 * logged the same way wherever it is found, with the severity→level mapping
 * living in exactly one place.
 */

import type { Logger } from "./logger.js";
import type { Finding, LogLevel, LogStage, Severity } from "../types.js";

/** The log level a finding of the given severity is recorded at. */
function levelForSeverity(severity: Severity): LogLevel {
  return severity === "error" ? "error" : severity === "warning" ? "warn" : "info";
}

/** Emit one `entry.flagged` event per finding, in order, under `stage`. */
export function reportFindings(logger: Logger, stage: LogStage, findings: Finding[]): void {
  for (const f of findings) {
    logger.emit({
      stage,
      level: levelForSeverity(f.severity),
      event: "entry.flagged",
      rule: f.rule,
      path: f.path,
      severity: f.severity,
    });
  }
}
