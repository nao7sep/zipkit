/**
 * The non-queue IPC handlers: the native input picker, on-demand archive
 * verification, and the Records window's reads. The queue's
 * plan/write/verify/trash live in queue.ts.
 */

import { dialog, ipcMain, shell } from "electron";
import type { AppInfo, JobEvent, VerifyResult } from "../shared/api.js";
import type { GuiSettings } from "../shared/spec.js";
import type { PaneLayout } from "../shared/layout.js";
import {
  RECORDS_PAGE_SIZE,
  isRecordKind,
  parseRecordsQuery,
  type RecordDetail,
  type RecordSources,
  type RecordsPage,
} from "../shared/records.js";
import type { RecordsRead, RecordsReadResults } from "./records-worker.js";
import { APP_NAME, APP_VERSION } from "../shared/identity.js";
import { errorInfo } from "./log.js";
import { getMainWindow, log, startProgressRun, toGuiError, zip } from "./runtime.js";
import { currentSettings } from "./settings.js";
import { submitSettings, discardSettingsSubmission } from "./settings-save.js";
import { languageEnvironment, mainTranslator } from "./i18n.js";
import { paneLayout, recordsListWidth, saveLayout, saveRecordsListWidth } from "./layout.js";
import { openRecordsWindow } from "./records-window.js";
import { isHttpUrl } from "./url.js";

export function registerIpc(): void {
  ipcMain.on("zipkit:reportError", (_event, context: string, error: unknown): void => {
    log.error("renderer operation failed", { context, error });
  });

  // Main's copy, from the startup load or the last save: a window opened or
  // reloaded mid-session never rereads the file.
  ipcMain.handle("zipkit:getSettings", (): GuiSettings => currentSettings());

  ipcMain.handle("zipkit:setSettings", (_event, draft: GuiSettings) => submitSettings(draft));
  ipcMain.handle("zipkit:discardSettingsSubmission", () => discardSettingsSubmission());

  ipcMain.handle("zipkit:getLanguageEnvironment", async () => languageEnvironment());

  ipcMain.handle("zipkit:getLayout", (): PaneLayout => paneLayout());

  ipcMain.handle("zipkit:setLayout", async (_event, layout: PaneLayout): Promise<void> => {
    try {
      await saveLayout(layout);
    } catch (err) {
      log.error("failed to persist layout", { error: errorInfo(err) });
      // The layout in use stays as it is; layout is optional state, so nothing
      // beyond this record reaches the user (unsaved-edits conventions).
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
          { onProgress: startProgressRun(jobId, "verify") },
        );
        log.info("verify done", { jobId, archive, reportOk: data.reportOk });
        return { ok: true, data };
      } catch (err) {
        log.error("verify failed", { jobId, archive, error: errorInfo(err) });
        return { ok: false, error: toGuiError(err) };
      }
    },
  );

  ipcMain.handle("zipkit:getJobEvents", (_event, jobId: string): Promise<JobEvent[]> => log.jobEvents(jobId));

  ipcMain.handle("zipkit:openRecordsWindow", async (): Promise<void> => {
    try {
      await openRecordsWindow();
    } catch (err) {
      log.error("records window failed to open", { error: errorInfo(err) });
      throw err;
    }
  });

  // The Records window's reads. A failed one is recorded here, with the full
  // error, and rejects so the window can say the records could not be read.
  const readRecords = async <R extends RecordsRead>(read: () => R): Promise<RecordsReadResults[R["op"]]> => {
    try {
      return await log.records(read());
    } catch (err) {
      log.warn("records read failed", { error: errorInfo(err) });
      throw err;
    }
  };

  ipcMain.handle("zipkit:readRecordsPage", (_event, query: unknown): Promise<RecordsPage> =>
    readRecords(() => ({ op: "page", query: parseRecordsQuery(query), pageSize: RECORDS_PAGE_SIZE })),
  );

  ipcMain.handle("zipkit:readRecordDetail", (_event, kind: unknown, id: unknown): Promise<RecordDetail | null> =>
    readRecords(() => {
      if (!isRecordKind(kind)) throw new Error("Invalid record read: kind must be a record kind.");
      if (!Number.isInteger(id)) throw new Error("Invalid record read: id must be an integer.");
      return { op: "detail", kind, id: id as number };
    }),
  );

  ipcMain.handle("zipkit:readRecordSources", async (): Promise<RecordSources> => ({
    currentSession: log.session,
    sessions: await readRecords(() => ({ op: "sessions" })),
  }));

  ipcMain.handle("zipkit:getRecordsListWidth", (): number => recordsListWidth());

  ipcMain.handle("zipkit:saveRecordsListWidth", async (_event, width: unknown): Promise<number> => {
    if (typeof width !== "number" || !Number.isFinite(width)) {
      throw new Error("Invalid records list width: it must be a finite number.");
    }
    try {
      return await saveRecordsListWidth(width);
    } catch (err) {
      log.error("failed to persist layout", { error: errorInfo(err) });
      throw err;
    }
  });

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
