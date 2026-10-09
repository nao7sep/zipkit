/**
 * The two questions quitting can ask: whether to cancel a job that is still
 * writing, verifying, or moving files to Trash, and what to do about a queue
 * that could not be saved. Both use the app's own question dialog (modal-dialog
 * conventions: app-owned message boxes), on the main window when it is open and
 * standalone when it is not. The safe choice is both the default and the
 * Escape/close outcome, so a reflexive dismissal never loses work. When the OS
 * ends the session, `signal` closes an open question as if cancelled, and quit
 * goes on without it.
 */

import type { BrowserWindow } from "electron";
import { mainTranslator } from "./i18n.js";
import { showAppQuestionDialog } from "./startup-dialog.js";
import type { QueueNotSavedChoice } from "./quit.js";

/** Resolves `true` if the user chose to quit anyway (cancelling the running
 *  job), `false` to keep working. Cancelling the job here reuses the engine's
 *  own abort path. A file whose Trash call is already under way may still
 *  reach the Trash, so the text promises only originals not yet sent. */
export async function confirmQuitDuringWrite(owner: BrowserWindow | null, signal: AbortSignal): Promise<boolean> {
  const { t } = mainTranslator();
  const response = await showAppQuestionDialog({
    owner: owner ?? undefined,
    title: t("quit.title"),
    message: `${t("quit.message")}\n\n${t("quit.detail")}`,
    labels: [t("quit.cancelAndQuit"), t("quit.keepWorking")],
    defaultId: 1,
    cancelId: 1,
    signal,
  });
  return response === 0;
}

/** Asks what to do about a queue that could not be saved on a quit the user
 *  started. Retry is the default, and Cancel, which keeps the app open, is the
 *  Escape/close outcome. */
export async function askQueueNotSaved(owner: BrowserWindow | null, signal: AbortSignal): Promise<QueueNotSavedChoice> {
  const { t } = mainTranslator();
  const choices: QueueNotSavedChoice[] = ["retry", "quit", "cancel"];
  const response = await showAppQuestionDialog({
    owner: owner ?? undefined,
    title: t("quit.queueNotSavedTitle"),
    message: `${t("quit.queueNotSavedMessage")}\n\n${t("quit.queueNotSavedDetail")}`,
    labels: [t("common.retry"), t("quit.quitAnyway"), t("common.cancel")],
    defaultId: 0,
    cancelId: 2,
    signal,
  });
  return choices[response] ?? "cancel";
}
