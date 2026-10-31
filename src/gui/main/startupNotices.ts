import type { MessageKey } from "../shared/i18n/catalogues.js";
import { message, type Message } from "../shared/i18n/translate.js";

export interface StartupNotice {
  title: MessageKey;
  message: Message;
}

/** What the launch found that the user should know while ZipKit runs: saved jobs it kept but could
 *  not read, and a records or backups database it left switched off. */
export interface StartupFindings {
  queueJobsKept: number;
  queueFile: string;
  /** The database left off for the session, or null when it is in use. */
  recordsOff: string | null;
  backupsOff: string | null;
}

/** One notice per finding, in the order the user meets them. */
export function buildStartupNotices(findings: StartupFindings): StartupNotice[] {
  const notices: StartupNotice[] = [];
  if (findings.queueJobsKept > 0) {
    notices.push({
      title: "notice.queueKeptTitle",
      message: message("notice.queueKeptMessage", { count: findings.queueJobsKept, file: findings.queueFile }),
    });
  }
  if (findings.recordsOff !== null) {
    notices.push({ title: "notice.recordsOffTitle", message: message("notice.recordsOffMessage", { file: findings.recordsOff }) });
  }
  if (findings.backupsOff !== null) {
    notices.push({ title: "notice.backupsOffTitle", message: message("notice.backupsOffMessage", { file: findings.backupsOff }) });
  }
  return notices;
}
