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

/** Resolves `true` if the user chose to quit anyway (cancelling the running
 *  job), `false` to keep working. Cancelling the job here reuses the engine's
 *  own abort path, which already leaves either a complete archive or none. */
export async function confirmQuitDuringWrite(owner: BrowserWindow | null): Promise<boolean> {
  const options = {
    type: "question" as const,
    buttons: ["Cancel the Job and Quit", "Keep Working"],
    defaultId: 1,
    cancelId: 1,
    title: "A job is still running",
    message: "An archive is still being written, verified, or moved to Trash.",
    detail: "Quitting now cancels that job. The archive will not be completed, and any originals not yet moved to Trash are kept.",
  };
  const result = await (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options));
  return result.response === 0;
}
