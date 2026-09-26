import type { MessageKey } from "../shared/i18n/catalogues.js";

export interface RecoveryDialog {
  title: MessageKey;
  message: MessageKey;
}

/** Where startup's material stores were quarantined, when they were (null = the
 *  store loaded fine). Layout is disposable view state and stays log-only. */
export interface StartupQuarantines {
  settingsQuarantinedTo: string | null;
  queueQuarantinedTo: string | null;
}

/** Build accurate user-facing reports for successfully quarantined stores. */
export function buildRecoveryDialogs(quarantines: StartupQuarantines): RecoveryDialog[] {
  const dialogs: RecoveryDialog[] = [];

  if (quarantines.settingsQuarantinedTo !== null) {
    dialogs.push({ title: "recovery.settingsTitle", message: "recovery.settingsMessage" });
  }

  if (quarantines.queueQuarantinedTo !== null) {
    dialogs.push({ title: "recovery.queueTitle", message: "recovery.queueMessage" });
  }

  return dialogs;
}
