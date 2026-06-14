/**
 * The non-queue IPC handlers: the native input picker and on-demand archive
 * verification. The queue's plan/write/verify/trash live in queue.ts.
 */

import { dialog, ipcMain } from "electron";
import type { VerifyResult } from "../shared/api.js";
import { forwardEvent, toGuiError, zip } from "./runtime.js";

export function registerIpc(): void {
  ipcMain.handle("zipkit:chooseInputs", async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      title: "Choose folders or files to archive",
      properties: ["openDirectory", "openFile", "multiSelections"],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle(
    "zipkit:verify",
    async (_event, archive: string, checkMetadata: boolean): Promise<VerifyResult> => {
      try {
        const data = await zip.extract({ archive, dryRun: true, checkMetadata }, { onProgress: forwardEvent });
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: toGuiError(err) };
      }
    },
  );
}
