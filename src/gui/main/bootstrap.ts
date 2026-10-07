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

import { app, BrowserWindow, nativeTheme, powerMonitor } from "electron";
import { APP_VERSION } from "../shared/identity.js";
import { applyThemePreference, followOsThemeChanges } from "./theme.js";
import path from "node:path";
import { buildRecoveryDialogs, startupHaltMessage } from "./recoveryDialogs.js";
import { loadRendererPage } from "./renderer-page.js";
import { notifyRecordsChanged } from "./records-window.js";
import { registerIpc } from "./ipc.js";
import { cancelRunningJobAndWait, flushQueue, hasRunningJob, registerQueueIpc, restoreQueue, saveQueueBeforeSessionEnd } from "./queue.js";
import { loadSettings, settingsFile } from "./settings.js";
import { applyLanguagePreference, mainTranslator, onLanguageChanged, readConfigText, readSavedPreference, settleLanguage } from "./i18n.js";
import { installAppMenu } from "./menu.js";
import { errorInfo } from "./log.js";
import { clearMainWindow, ensureMainWindow, getMainWindow, log, sendQueueSaved } from "./runtime.js";
import { minWindowHeight, minWindowWidth } from "../shared/layout.js";
import { layoutWritesSettled, loadLayout } from "./layout.js";
import { loadQueue } from "./persist.js";
import { notifyStartupFailure, showAppMessageDialog } from "./startup-dialog.js";
import { askQueueNotSaved, confirmQuitDuringWrite } from "./quit-confirm-dialog.js";
import { configureWindowActivity } from "./windowActivity.js";
import { createQuitControl, endSessionNow, finishStartupHalt, stopFlushAndExit, type QuitStep } from "./quit.js";
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
  // Off macOS closing the main window quits, so the close becomes the quit:
  // the window stays open when the user keeps working or cancels the quit, and
  // the quit's own exit closes it. A window whose document failed to load just
  // closes.
  win.on("close", (event) => {
    if (process.platform === "darwin" || !flushQueueOnClose) return;
    event.preventDefault();
    app.quit();
  });
  // Windows ends the session without a quit event (unsaved-edits-conventions,
  // Quitting); macOS and Linux announce it through powerMonitor below.
  win.on("session-end", () => {
    log.info("session ending", { runningJob: hasRunningJob() });
    endSessionNow({
      saveQueueNow: saveQueueBeforeSessionEnd,
      onSaved: () => log.info("app quitting"),
      onStepFailed: logQuitStepFailure,
      exit: (code) => app.exit(code),
    });
  });
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
  await finishStartupHalt({
    present: () => notifyStartupFailure(halt.key, halt.values),
    closeBackups: () => closeBackupStore(),
    closeLog: () => log.close(),
    onFailed: (failure) => log.error("startup failure presentation or cleanup failed", { error: errorInfo(failure) }),
    exit: (code) => app.exit(code),
  });
}

function logLanguageError(error: unknown): void {
  log.warn("the interface language could not reach a native surface", { error: errorInfo(error) });
}

app.whenReady().then(async () => {
  // macOS and Linux announce the end of the session before its quit arrives
  // through before-quit; that quit then asks nothing.
  powerMonitor.on("shutdown", () => {
    log.info("session ending");
    quit.sessionEnding();
  });
  // The language is settled before anything draws: the saved choice is read
  // straight from config.json so the menu that replaces Electron's default in
  // this same turn is already in it. The store's load below can still reset it.
  await settleLanguage(readSavedPreference(await readConfigText(settingsFile())), logLanguageError);
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

// What each quit step's failure is logged as. The queue is the user's own
// work, so the window shows its failure too, until a later save succeeds.
function logQuitStepFailure(step: QuitStep, error: unknown): void {
  const info = { error: errorInfo(error) };
  switch (step) {
    case "job":
      log.warn("the cancelled job did not stop in time; quitting without it", info);
      return;
    case "queue":
      log.error("failed to flush the queue before quit", info);
      sendQueueSaved(false);
      return;
    case "layout":
      log.warn("the pane layout write did not land before quit", info);
      return;
    case "question":
      log.error("quit question could not be presented; user quit cancelled", info);
      return;
    case "backups":
      log.warn("the backup history did not close before quit", info);
      return;
  }
}

const quit = createQuitControl({
  onFailed: (error) => log.error("quit request failed; the app remains open", { error: errorInfo(error) }),
  hasRunningJob,
  confirmQuit: (signal) => confirmQuitDuringWrite(getMainWindow(), signal),
  shutdown: (session) =>
    stopFlushAndExit(
      {
        stopJob: cancelRunningJobAndWait,
        flush: flushQueue,
        onFlushed: () => log.info("app quitting"),
        askQueueNotSaved: (signal) => askQueueNotSaved(getMainWindow(), signal),
        onCancelled: () => log.info("quit cancelled with the queue not saved"),
        settleLayout: layoutWritesSettled,
        closeBackups: () => closeBackupStore(),
        closeLog: () => log.close(),
        onStepFailed: logQuitStepFailure,
        exit: (code) => app.exit(code),
      },
      session,
    ),
});

app.on("before-quit", quit.beforeQuit);
