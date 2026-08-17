export interface RecoveryDialog {
  title: string;
  message: string;
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
    dialogs.push({
      title: "Settings were reset",
      message:
        "An unreadable settings file was set aside here:\n\n" +
        quarantines.settingsQuarantinedTo +
        "\n\nZipKit started with default settings. Your archive files on disk are untouched.",
    });
  }

  if (quarantines.queueQuarantinedTo !== null) {
    dialogs.push({
      title: "Saved queue was reset",
      message:
        "ZipKit could not read its saved pending jobs. The queue file was set aside here:\n\n" +
        quarantines.queueQuarantinedTo +
        "\n\nZipKit started with an empty queue. The file above still contains the original queue data; your archive files on disk are untouched.",
    });
  }

  return dialogs;
}
