import type { MessageKey } from "../shared/i18n/catalogues.js";
import { message, type Message } from "../shared/i18n/translate.js";
import { NewerFormatError } from "./formatVersions.js";

export interface RecoveryDialog {
  title: MessageKey;
  /** Names where the unreadable file was preserved and what ZipKit uses instead. */
  message: Message;
}

/** Where material stores were quarantined, when they were (null = the store
 *  loaded fine). Layout is disposable view state and stays log-only. */
export interface StartupQuarantines {
  settingsQuarantinedTo: string | null;
  queueQuarantinedTo: string | null;
}

/** Build accurate user-facing reports for successfully quarantined stores. */
export function buildRecoveryDialogs(quarantines: StartupQuarantines): RecoveryDialog[] {
  const dialogs: RecoveryDialog[] = [];

  if (quarantines.settingsQuarantinedTo !== null) {
    dialogs.push({
      title: "recovery.settingsTitle",
      message: message("recovery.settingsMessage", { file: quarantines.settingsQuarantinedTo }),
    });
  }

  if (quarantines.queueQuarantinedTo !== null) {
    dialogs.push({
      title: "recovery.queueTitle",
      message: message("recovery.queueMessage", { file: quarantines.queueQuarantinedTo }),
    });
  }

  return dialogs;
}

/** The fatal launch message for an error that halted startup: a store a newer
 *  build wrote is named by its path and was left in place; anything else gets
 *  the general guidance, its diagnostic staying in the log. */
export function startupHaltMessage(error: unknown): Message {
  if (error instanceof NewerFormatError) return message("startup.newerStore", { file: error.file });
  return message("startup.halted");
}
