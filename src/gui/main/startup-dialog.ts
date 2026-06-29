import { dialog } from "electron";

/**
 * Native startup-error surface. It runs before the renderer (and its named
 * DialogHost) exists, so it is the main-process fatal-halt box the modal-dialog
 * conventions allow for a launch that cannot proceed — kept here, named and
 * greppable in a *-dialog file, rather than inline in the bootstrap.
 */
export function notifyStartupFailure(message: string): void {
  dialog.showErrorBox("ZipKit cannot start", message);
}
