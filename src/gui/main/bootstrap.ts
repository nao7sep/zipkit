/**
 * The Electron main-process bootstrap: create the window, register the IPC seam
 * (plain handlers + the queue engine), and load the renderer (the electron-vite
 * dev server in development, the built file in production). The app is the
 * primary face of ZipKit; the SDK is driven from here.
 *
 * Loaded by `./index` via a dynamic import *after* the storage root has been
 * validated, so the eager log/queue path resolution in the modules below runs
 * only once the root is known good.
 */

import { app, BrowserWindow, nativeTheme } from "electron";
import { APP_VERSION } from "../shared/identity.js";
import { applyThemePreference, followOsThemeChanges } from "./theme.js";
import path from "node:path";
import { buildRecoveryDialogs, startupHaltMessage } from "./recoveryDialogs.js";
import { loadRendererPage } from "./renderer-page.js";
import { notifyRecordsChanged } from "./records-window.js";
import { registerIpc } from "./ipc.js";
import { cancelRunningJobAndWait, flushQueue, hasRunningJob, registerQueueIpc, restoreQueue } from "./queue.js";
import { loadSettings, settingsFile } from "./settings.js";
import { applyLanguagePreference, mainTranslator, onLanguageChanged, readConfigText, readSavedPreference, settleLanguage } from "./i18n.js";
import { installAppMenu } from "./menu.js";
import { errorInfo } from "./log.js";
import { clearMainWindow, ensureMainWindow, getMainWindow, log } from "./runtime.js";
import { minWindowHeight, minWindowWidth } from "../shared/layout.js";
import { loadLayout } from "./layout.js";
import { loadQueue } from "./persist.js";
import { notifyStartupFailure, showAppMessageDialog } from "./startup-dialog.js";
import { confirmQuitDuringWrite } from "./quit-confirm-dialog.js";
import { configureWindowActivity } from "./windowActivity.js";
import { createQuitHandler, QUIT_WAIT_MS, stopFlushAndExit } from "./quit.js";
import { closeBackupStore } from "./backupStore.js";
import { configureWindowMinimum } from "./window-minimum.js";
import { mainWindowOptions } from "./window-options.js";
import { createWindowWithUsablePersistedBounds } from "./window-state-recovery.js";

// Last-resort hooks: record the failure. A handled `uncaughtException` keeps the
// process alive, so the records thread still writes the line.
process.on("uncaughtException", (err) => {
  log.error("uncaught exception", { error: errorInfo(err) });
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { error: errorInfo(reason) });
});

function createWindow(): BrowserWindow {
  const options = mainWindowOptions(path.join(import.meta.dirname, "../preload/index.mjs"), nativeTheme.shouldUseDarkColors);
  const owned = ensureMainWindow(() =>
    createWindowWithUsablePersistedBounds("main", () => new BrowserWindow(options)),
  );
  const win = owned.window;
  if (!owned.created) return win;
  configureWindowMinimum(win, () => ({ width: minWindowWidth(), height: minWindowHeight() }),
    (error) => log.warn("window minimum could not be updated", { error: errorInfo(error) }));
  configureWindowActivity(app, win);

  let flushQueueOnClose = true;
  win.on("closed", () => {
    clearMainWindow(win);
    if (flushQueueOnClose) {
      void flushQueue().catch((err) =>
        log.error("failed to flush the queue after window close", { error: errorInfo(err) }),
      );
    }
    // The main window, apart from the Records window beside it: closing it
    // quits on Windows and Linux, and on macOS the Dock reopens it.
    if (process.platform !== "darwin") app.quit();
  });
  log.info("main window created");

  const load = loadRendererPage(win, "index.html");
  void load.then(() => {
    if (!win.isDestroyed()) win.show();
  }).catch((error) => {
    log.error("main window document failed to load", { error: errorInfo(error) });
    // Closing this failed shell must not flush the in-memory queue over the
    // saved one.
    flushQueueOnClose = false;
    if (!win.isDestroyed()) win.close();
    void notifyStartupFailure("startup.windowLoad").catch((dialogError) => log.error("window load failure dialog failed", { error: errorInfo(dialogError) }));
  });
  return win;
}

let windowCreationReady = false;
let activationPending = false;

function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function activateMainWindow(): void {
  const current = getMainWindow();
  if (current) {
    focusWindow(current);
    return;
  }
  if (!windowCreationReady) {
    activationPending = true;
    return;
  }
  focusWindow(createWindow());
}

// Any startup failure reaches the user and halts. The diagnostic stays in the
// log; the app-authored dialog carries stable recovery guidance, and names the
// file when a newer build wrote it.
async function reportStartupHalt(error: unknown): Promise<void> {
  log.error("startup halted", { error: errorInfo(error) });
  const halt = startupHaltMessage(error);
  await notifyStartupFailure(halt.key, halt.values);
  await closeBackupStore();
  await log.close();
  app.exit(1);
}

function logLanguageError(error: unknown): void {
  log.warn("the interface language could not reach a native surface", { error: errorInfo(error) });
}

app.whenReady().then(async () => {
  // The language is settled before anything draws: the saved choice is read
  // straight from config.json so the menu that replaces Electron's default in
  // this same turn is already in it. The store's load below can still reset it.
  await settleLanguage(readSavedPreference(readConfigText(settingsFile())), logLanguageError);
  installAppMenu(mainTranslator());
  onLanguageChanged(installAppMenu);
  log.info("app started", {
    version: APP_VERSION,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    records: log.database,
  });
  // Just-in-case data backup (data-backup conventions): write-through, not a startup scan. Each managed
  // text save (except volatile layout.json) records the exact bytes into `~/.zipkit/backups.sqlite3` strictly after its atomic rename
  // lands (see managedJson.ts's writeManagedJson + the backup store). There is nothing to kick off here.
  registerIpc();
  registerQueueIpc();
  log.onStored(notifyRecordsChanged);

  // Load every store before any window exists, so the renderer can never save
  // over an unreadable file or one a newer build wrote. This also keeps failed
  // quarantines and newer formats on the startup error path. Each load returns
  // its own quarantine outcome; layout is disposable view state and its
  // recovery stays log-only.
  const settingsLoad = await loadSettings(log);
  const { quarantinedTo: settingsQuarantinedTo } = settingsLoad;
  // The saved theme reaches the title bar, the renderer's prefers-color-scheme,
  // and the recovery dialogs before the window exists, so launch never shows the
  // OS appearance and then switches. A halt before this point follows the OS.
  applyThemePreference(settingsLoad.value.theme);
  followOsThemeChanges();
  // A quarantined or hand-edited file may settle on another language than the
  // raw read above; the store's value wins before the window opens.
  await applyLanguagePreference(settingsLoad.value.language, logLanguageError);
  await loadLayout(log);
  const queueLoad = await loadQueue(log);

  windowCreationReady = true;
  const initialWindow = createWindow();
  if (activationPending) {
    activationPending = false;
    focusWindow(initialWindow);
  }
  restoreQueue(queueLoad.value);

  for (const recoveryDialog of buildRecoveryDialogs({ settingsQuarantinedTo, queueQuarantinedTo: queueLoad.quarantinedTo })) {
    const { t } = mainTranslator();
    await showAppMessageDialog({
      owner: initialWindow,
      title: t(recoveryDialog.title),
      message: t(recoveryDialog.message.key, recoveryDialog.message.values),
      button: "ok",
    });
  }
  app.on("activate", () => {
    activateMainWindow();
  });
}).catch(reportStartupHalt);

app.on("second-instance", () => {
  activateMainWindow();
});

app.on("window-all-closed", () => {
  const quitting = process.platform !== "darwin";
  log.info("all windows closed", { quitting });
  if (quitting) app.quit();
});

app.on(
  "before-quit",
  createQuitHandler({
    hasRunningJob,
    confirmQuit: () => confirmQuitDuringWrite(getMainWindow()),
    shutdown: () =>
      stopFlushAndExit({
        stopJob: cancelRunningJobAndWait,
        flush: flushQueue,
        onJobStopTimeout: () =>
          log.warn("the cancelled job did not stop in time; quitting without it", { waitMs: QUIT_WAIT_MS }),
        onFlushed: () => log.info("app quitting"),
        onFlushError: async (err) => {
          log.error("failed to flush the queue before quit", { error: errorInfo(err) });
          const { t } = mainTranslator();
          await showAppMessageDialog({
            owner: getMainWindow() ?? undefined,
            title: t("quit.queueNotSavedTitle"),
            message: t("quit.queueNotSaved"),
            button: "ok",
          });
        },
        closeBackups: () => closeBackupStore(),
        closeLog: () => log.close(),
        exit: (code) => app.exit(code),
      }),
  }),
);
