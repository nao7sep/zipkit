/**
 * The IPC seam: each renderer call maps to exactly one SDK verb, mirroring the
 * thin-wrapper rule the CLI follows. The main process owns the `ZipKit` instance
 * (one per app run = one logging session, per the SDK's session model) and the
 * native dialogs; the renderer only invokes these channels.
 */

import { dialog, ipcMain } from "electron";
import { ZipKit, ZipKitError } from "../../sdk/index.js";
import type { ArchiveSpec } from "../../sdk/types.js";
import type { GuiError, PlanResult } from "../shared/api.js";

/** One instance for the app's lifetime: one session log the whole run appends to. */
const zip = new ZipKit();

/** Map a thrown value into the structured fault the renderer renders. */
function toGuiError(err: unknown): GuiError {
  if (err instanceof ZipKitError) {
    return { type: err.errorType, code: err.code, message: err.message };
  }
  return {
    type: "unknown",
    code: "unknown",
    message: err instanceof Error ? err.message : String(err),
  };
}

export function registerIpc(): void {
  ipcMain.handle("zipkit:chooseInputs", async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      title: "Choose folders or files to archive",
      properties: ["openDirectory", "openFile", "multiSelections"],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("zipkit:plan", async (_event, spec: ArchiveSpec): Promise<PlanResult> => {
    try {
      return { ok: true, plan: await zip.plan(spec) };
    } catch (err) {
      return { ok: false, error: toGuiError(err) };
    }
  });
}
