/**
 * The non-queue IPC handlers: the native input picker and on-demand archive
 * verification. The queue's plan/write/verify/trash live in queue.ts.
 */

import { dialog, ipcMain, shell } from "electron";
import type { AppInfo, VerifyResult } from "../shared/api.js";
import type { GuiSettings } from "../shared/spec.js";
import type { PaneLayout } from "../shared/layout.js";
import { APP_NAME, APP_VERSION } from "../shared/identity.js";
import { errorInfo } from "./log.js";
import { getMainWindow, log, sendEvent, toGuiError, zip } from "./runtime.js";
import { loadSettings, saveSettings } from "./settings.js";
import { applyThemePreference } from "./theme.js";
import { applyLanguagePreference, languageEnvironment, mainTranslator } from "./i18n.js";
import { loadLayout, saveLayout } from "./layout.js";
import { isHttpUrl } from "./url.js";

export function registerIpc(): void {
  ipcMain.on("zipkit:reportError", (_event, context: string, error: unknown): void => {
    log.error("renderer operation failed", { context, error });
  });

  // A mid-session quarantine here is already warned to the session log by the
  // loader; the startup report in bootstrap covers the material case.
  ipcMain.handle("zipkit:getSettings", async (): Promise<GuiSettings> => (await loadSettings(log)).value);

  ipcMain.handle("zipkit:setSettings", async (_event, settings: GuiSettings): Promise<void> => {
    try {
      await saveSettings(settings);
    } catch (err) {
      log.error("failed to persist settings", { error: errorInfo(err) });
      throw err;
    }
    // Settings apply on Save, the theme and the language included (app-chrome
    // conventions, Theme; localization conventions).
    applyThemePreference(settings.theme);
    applyLanguagePreference(settings.language, (error) =>
      log.warn("the interface language could not reach a native surface", { error: errorInfo(error) }),
    );
  });

  ipcMain.handle("zipkit:getLanguageEnvironment", async () => languageEnvironment());

  ipcMain.handle("zipkit:getLayout", async (): Promise<PaneLayout> => (await loadLayout(log)).value);

  ipcMain.handle("zipkit:setLayout", async (_event, layout: PaneLayout): Promise<void> => {
    try {
      await saveLayout(layout);
    } catch (err) {
      log.error("failed to persist layout", { error: errorInfo(err) });
      // The in-memory layout remains valid and usable, but the renderer owns the
      // persistent user-facing result for this user gesture.
      throw err;
    }
  });

  ipcMain.handle("zipkit:chooseInputs", async (): Promise<string[]> => {
    const owner = getMainWindow();
    const options: Electron.OpenDialogOptions = {
      title: mainTranslator().t("picker.inputsTitle"),
      properties: ["openDirectory", "openFile", "multiSelections"],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const chosen = result.canceled ? [] : result.filePaths;
    log.info("inputs chosen", { count: chosen.length });
    return chosen;
  });

  ipcMain.handle("zipkit:chooseOutputDir", async (): Promise<string> => {
    const owner = getMainWindow();
    const options: Electron.OpenDialogOptions = {
      title: mainTranslator().t("picker.outputTitle"),
      properties: ["openDirectory", "createDirectory"],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
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

  // The app knows its own identity. app.getName()/getVersion() answer about the
  // running binary, so an unpackaged run — the way the app is dogfooded and shot
  // for screenshots — reported "Electron 44.2.0" in About. The name is this app's
  // own, and the version is package.json's, injected at build.
  ipcMain.handle("zipkit:appInfo", async (): Promise<AppInfo> => ({
    name: APP_NAME,
    version: APP_VERSION,
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
