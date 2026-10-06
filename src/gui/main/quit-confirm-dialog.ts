/**
 * The two questions quitting can ask: whether to cancel a job that is still
 * writing, verifying, or moving originals to Trash, and what to do about a
 * queue that could not be saved. Electron's own `dialog.showMessageBox` is used
 * directly (no app-drawn chrome) because each is a native, one-shot choice with
 * no draft state — the platform surface already gives it owner, modal state,
 * default/cancel buttons, focus, and a button row laid out to fit its labels,
 * per the modal-dialog conventions; the safe choice is both the default and
 * the Escape/close outcome, so a reflexive dismissal never loses work. When the
 * OS ends the session, `signal` closes an open question as if cancelled, and
 * quit goes on without it (on macOS only a question with an owner window can
 * be closed that way).
 */

import { BrowserWindow, dialog } from "electron";
import { mainTranslator } from "./i18n.js";
import type { QueueNotSavedChoice } from "./quit.js";

/** Resolves `true` if the user chose to quit anyway (cancelling the running
 *  job), `false` to keep working. Cancelling the job here reuses the engine's
 *  own abort path. An original whose Trash call is already under way may still
 *  reach the Trash, so the text promises only those not yet sent. */
export async function confirmQuitDuringWrite(owner: BrowserWindow | null, signal: AbortSignal): Promise<boolean> {
  const { t } = mainTranslator();
  const options = {
    type: "question" as const,
    buttons: [t("quit.cancelAndQuit"), t("quit.keepWorking")],
    defaultId: 1,
    cancelId: 1,
    title: t("quit.title"),
    message: t("quit.message"),
    detail: t("quit.detail"),
    signal,
  };
  const result = await (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options));
  return result.response === 0;
}

/** Asks what to do about a queue that could not be saved on a quit the user
 *  started. Retry is the default, and Cancel, which keeps the app open, is the
 *  Escape/close outcome. `noLink` keeps every choice a plain button on Windows. */
export async function askQueueNotSaved(owner: BrowserWindow | null, signal: AbortSignal): Promise<QueueNotSavedChoice> {
  const { t } = mainTranslator();
  const choices: QueueNotSavedChoice[] = ["retry", "quit", "cancel"];
  const options = {
    type: "warning" as const,
    buttons: [t("common.retry"), t("quit.quitAnyway"), t("common.cancel")],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: t("quit.queueNotSavedTitle"),
    message: t("quit.queueNotSavedMessage"),
    detail: t("quit.queueNotSavedDetail"),
    signal,
  };
  const result = await (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options));
  return choices[result.response] ?? "cancel";
}
