import type { MessageKey } from "../shared/i18n/catalogues.js";
import { message, type Message } from "../shared/i18n/translate.js";

export interface RecoveryDialog {
  title: MessageKey;
  /** Names where the unreadable file was preserved and what ZipKit uses instead. */
  message: Message;
}

/** Where material stores were set aside, when they were (null = the store
 *  loaded fine), and how many saved jobs the queue still restored. Layout is
 *  disposable view state and stays log-only. */
export interface StartupQuarantines {
  settingsQuarantinedTo: string | null;
  queueQuarantinedTo: string | null;
  queueJobsRestored: number;
}

/** Build accurate user-facing reports for stores that were set aside. */
export function buildRecoveryDialogs(quarantines: StartupQuarantines): RecoveryDialog[] {
  const dialogs: RecoveryDialog[] = [];

  if (quarantines.settingsQuarantinedTo !== null) {
    dialogs.push({
      title: "recovery.settingsTitle",
      message: message("recovery.settingsMessage", { file: quarantines.settingsQuarantinedTo }),
    });
  }

  if (quarantines.queueQuarantinedTo !== null) {
    dialogs.push(quarantines.queueJobsRestored > 0
      ? {
          title: "recovery.queuePartialTitle",
          message: message("recovery.queuePartialMessage", { file: quarantines.queueQuarantinedTo }),
        }
      : {
          title: "recovery.queueTitle",
          message: message("recovery.queueMessage", { file: quarantines.queueQuarantinedTo }),
        });
  }

  return dialogs;
}
