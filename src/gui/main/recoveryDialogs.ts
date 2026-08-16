import path from "node:path";
import type { QuarantineNotice } from "./managedJson.js";

export interface RecoveryDialog {
  title: string;
  message: string;
}

/** Build accurate user-facing reports for successfully quarantined stores. */
export function buildRecoveryDialogs(notices: QuarantineNotice[]): RecoveryDialog[] {
  const queue = notices.filter((notice) => path.basename(notice.original) === "queue.json");
  const settings = notices.filter((notice) => path.basename(notice.original) !== "queue.json");
  const dialogs: RecoveryDialog[] = [];

  if (settings.length > 0) {
    dialogs.push({
      title: "Settings were reset",
      message:
        "An unreadable settings file was set aside here:\n\n" +
        settings.map((notice) => notice.quarantined).join("\n") +
        "\n\nZipKit started with default settings. Your archive files on disk are untouched.",
    });
  }

  if (queue.length > 0) {
    dialogs.push({
      title: "Saved queue was reset",
      message:
        "ZipKit could not read its saved pending jobs. The queue file was set aside here:\n\n" +
        queue.map((notice) => notice.quarantined).join("\n") +
        "\n\nZipKit started with an empty queue. The file above still contains the original queue data; your archive files on disk are untouched.",
    });
  }

  return dialogs;
}
