/**
 * The startup edge for the data backup: runs one pass without blocking startup and logs the outcome. This
 * is the only place the feature logs; the pass itself ({@link runBackup}) does not. Best-effort — it never
 * blocks the window, shows an error, or crashes the app.
 *
 * Electron's main process is single-threaded, so "background" here means fire-and-forget async on the
 * event loop after config is materialized: the renderer is a separate process, so this never blocks the
 * UI's paint.
 */
import { runBackup } from "./backupEngine.js";
import { log } from "../runtime.js";
import { errorInfo } from "../log.js";
import type { AppLog } from "../log.js";
import type { BackupReport } from "./backupTypes.js";

/** Runs one backup pass in the background and logs its outcome. Fire-and-forget; never throws. The
 *  logger and clock are injectable so the startup edge is unit-testable. */
export function runBackupInBackground(logger: AppLog = log, now: () => Date = () => new Date()): void {
  void runOnce(logger, now);
}

async function runOnce(logger: AppLog, now: () => Date): Promise<void> {
  try {
    logReport(logger, await runBackup(now()));
  } catch (err) {
    // The engine captures its own failures in the report; this is the final backstop so a bug here can
    // never surface to the user or take down the app.
    logger.error("backup: unexpected failure", { error: errorInfo(err) });
  }
}

function logReport(logger: AppLog, report: BackupReport): void {
  for (const skip of report.skips) {
    logger.warn("backup: skipped a file", { path: skip.path, reason: skip.reason });
  }

  if (report.indexWasReset) {
    logger.warn("backup: index was unreadable and reset; this run is a full backup");
  }

  if (report.fatal !== undefined) {
    logger.error("backup: run failed", { error: errorInfo(report.fatal) });
    return;
  }

  if (report.nothingChanged) {
    logger.debug("backup: nothing changed, no archive written");
    return;
  }

  logger.info("backup: archive written", {
    archive: report.archiveFileName,
    files: report.filesArchived,
  });
}
