/**
 * The non-queue IPC handlers: the native input picker and on-demand archive
 * verification. The queue's plan/write/verify/trash live in queue.ts.
 */

import { app, dialog, ipcMain, shell } from "electron";
import type { AppInfo, VerifyResult } from "../shared/api.js";
import type { GuiSettings } from "../shared/spec.js";
import type { PaneLayout } from "../shared/layout.js";
import { errorInfo } from "./log.js";
import { getMainWindow, log, sendEvent, toGuiError, zip } from "./runtime.js";
import { loadSettings, saveSettings } from "./settings.js";
import { loadLayout, saveLayout } from "./layout.js";
import { isHttpUrl } from "./url.js";

export function registerIpc(): void {
  ipcMain.handle("zipkit:getSettings", async (): Promise<GuiSettings> => loadSettings());

  ipcMain.handle("zipkit:setSettings", async (_event, settings: GuiSettings): Promise<void> => {
    try {
      await saveSettings(settings);
    } catch (err) {
      // Best-effort and non-fatal: a write failure is logged to the session log,
      // never thrown back across the bridge.
      log.error("failed to persist settings", { error: errorInfo(err) });
    }
  });

  ipcMain.handle("zipkit:getLayout", async (): Promise<PaneLayout> => loadLayout());

  ipcMain.handle("zipkit:setLayout", async (_event, layout: PaneLayout): Promise<void> => {
    try {
      await saveLayout(layout);
    } catch (err) {
      // Best-effort and non-fatal: a write failure is logged, never thrown back.
      log.error("failed to persist layout", { error: errorInfo(err) });
    }
  });

  ipcMain.handle("zipkit:chooseInputs", async (): Promise<string[]> => {
    const owner = getMainWindow();
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          title: "Choose directories or files to archive",
          properties: ["openDirectory", "openFile", "multiSelections"],
        })
      : await dialog.showOpenDialog({
          title: "Choose directories or files to archive",
          properties: ["openDirectory", "openFile", "multiSelections"],
        });
    const chosen = result.canceled ? [] : result.filePaths;
    log.info("inputs chosen", { count: chosen.length });
    return chosen;
  });

  ipcMain.handle("zipkit:chooseOutputDir", async (): Promise<string> => {
    const owner = getMainWindow();
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          title: "Choose the output directory",
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          title: "Choose the output directory",
          properties: ["openDirectory", "createDirectory"],
        });
    const dir = result.canceled || result.filePaths.length === 0 ? "" : result.filePaths[0]!;
    log.info("output directory chosen", { chosen: dir !== "" });
    return dir;
  });

  ipcMain.handle(
    "zipkit:verify",
    async (_event, jobId: string, archive: string, checkMetadata: boolean): Promise<VerifyResult> => {
      log.info("verify requested", { jobId, archive, checkMetadata });
      try {
        const data = await zip.extract(
          { archive, dryRun: true, checkMetadata },
          { onProgress: (e) => sendEvent({ ...e, jobId }) },
        );
        log.info("verify done", { jobId, archive, reportOk: data.reportOk });
        return { ok: true, data };
      } catch (err) {
        log.error("verify failed", { jobId, archive, error: errorInfo(err) });
        return { ok: false, error: toGuiError(err) };
      }
    },
  );

  ipcMain.handle("zipkit:reveal", async (_event, path: string): Promise<void> => {
    shell.showItemInFolder(path);
  });

  ipcMain.handle("zipkit:appInfo", async (): Promise<AppInfo> => ({
    name: app.getName(),
    version: app.getVersion(),
  }));

  ipcMain.handle("zipkit:openExternal", async (_event, url: string): Promise<void> => {
    // Only ever hand the OS browser an http(s) URL — never a file:// or app-scheme link.
    if (isHttpUrl(url)) {
      await shell.openExternal(url);
    } else {
      log.warn("openExternal refused non-http url", { url });
    }
  });
}
