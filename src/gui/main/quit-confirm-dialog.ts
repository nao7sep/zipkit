/**
 * The one confirm dialog quitting can show: a job is still writing, verifying,
 * or moving originals to Trash. Electron's own `dialog.showMessageBox` is used
 * directly (no app-drawn chrome) because this is a native, one-shot yes/no
 * choice with no draft state — the platform surface already gives it owner,
 * modal state, default/cancel buttons, and focus per the modal-dialog
 * conventions; the safe (non-destructive) choice is both the default and the
 * Escape/close outcome, so a reflexive dismissal never loses the job.
 */

import { BrowserWindow, dialog } from "electron";
import { mainTranslator } from "./i18n.js";

/** Resolves `true` if the user chose to quit anyway (cancelling the running
 *  job), `false` to keep working. Cancelling the job here reuses the engine's
 *  own abort path. An original whose Trash call is already under way may still
 *  reach the Trash, so the text promises only those not yet sent. */
export async function confirmQuitDuringWrite(owner: BrowserWindow | null): Promise<boolean> {
  const { t } = mainTranslator();
  const options = {
    type: "question" as const,
    buttons: [t("quit.cancelAndQuit"), t("quit.keepWorking")],
    defaultId: 1,
    cancelId: 1,
    title: t("quit.title"),
    message: t("quit.message"),
    detail: t("quit.detail"),
  };
  const result = await (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options));
  return result.response === 0;
}
