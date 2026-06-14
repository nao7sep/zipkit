/**
 * The non-queue IPC handlers: the native input picker and on-demand archive
 * verification. The queue's plan/write/verify/trash live in queue.ts.
 */

import { dialog, ipcMain } from "electron";
import type { VerifyResult } from "../shared/api.js";
import { errorInfo } from "./log.js";
import { forwardEvent, log, toGuiError, zip } from "./runtime.js";

export function registerIpc(): void {
  ipcMain.handle("zipkit:chooseInputs", async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      title: "Choose folders or files to archive",
      properties: ["openDirectory", "openFile", "multiSelections"],
    });
    const chosen = result.canceled ? [] : result.filePaths;
    log.info("inputs chosen", { count: chosen.length });
    return chosen;
  });

  ipcMain.handle(
    "zipkit:verify",
    async (_event, archive: string, checkMetadata: boolean): Promise<VerifyResult> => {
      log.info("verify requested", { archive, checkMetadata });
      try {
        const data = await zip.extract({ archive, dryRun: true, checkMetadata }, { onProgress: forwardEvent });
        log.info("verify done", { archive, reportOk: data.reportOk });
        return { ok: true, data };
      } catch (err) {
        log.error("verify failed", { archive, error: errorInfo(err) });
        return { ok: false, error: toGuiError(err) };
      }
    },
  );
}
