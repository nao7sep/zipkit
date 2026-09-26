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
import { installContentSecurityPolicy } from "./csp.js";
import { buildRecoveryDialogs } from "./recoveryDialogs.js";
import { isLoopbackRendererUrl, isSameOrigin, windowOpenHandler } from "./navigation.js";
import { registerIpc } from "./ipc.js";
import { cancelRunningJobAndWait, flushQueue, hasRunningJob, registerQueueIpc, restoreQueue } from "./queue.js";
import { loadSettings, saveSettings, settingsFile } from "./settings.js";
import { applyLanguagePreference, mainTranslator, onLanguageChanged, readConfigText, readSavedPreference, settleLanguage } from "./i18n.js";
import { installAppMenu } from "./menu.js";
import { errorInfo } from "./log.js";
import { clearMainWindow, ensureMainWindow, getMainWindow, log } from "./runtime.js";
import { minWindowHeight, minWindowWidth } from "../shared/layout.js";
import { loadLayout } from "./layout.js";
import { notifyStartupFailure, showAppMessageDialog } from "./startup-dialog.js";
import { confirmQuitDuringWrite } from "./quit-confirm-dialog.js";
import { configureWindowActivity } from "./windowActivity.js";
import { QUIT_WAIT_MS, stopFlushAndExit } from "./quit.js";
import { configureWindowMinimum } from "./window-minimum.js";
import { mainWindowOptions } from "./window-options.js";
import { createWindowWithUsablePersistedBounds } from "./window-state-recovery.js";

// Last-resort hooks: record the failure before the process can die. The session
// log appends synchronously, so the line is on disk by the time these return.
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
    if (!flushQueueOnClose) return;
    void flushQueue().catch((err) =>
      log.error("failed to flush the queue after window close", { error: errorInfo(err) }),
    );
  });
  log.info("main window created");

  // Navigation guard (defense-in-depth alongside the CSP): the SPA stays on its
  // own origin and opens no child windows, so deny every renderer-initiated
  // window open and prevent any navigation that would leave the loaded origin.
  // Same-origin navigation (reloads / in-app routing) is left to proceed.
  win.webContents.setWindowOpenHandler(windowOpenHandler);
  win.webContents.on("will-navigate", (event, url) => {
    if (!isSameOrigin(win.webContents.getURL(), url)) event.preventDefault();
  });

  const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
  let load: Promise<void>;
  if (devUrl) {
    if (!isLoopbackRendererUrl(devUrl)) {
      throw new Error("ELECTRON_RENDERER_URL must be an HTTP(S) loopback URL");
    }
    load = win.loadURL(devUrl);
  } else {
    // Production path only (run-built / rebuild): enforce the strict CSP via a
    // response header before loading the file. Dev leaves the policy unset so
    // electron-vite's HMR keeps working.
    installContentSecurityPolicy();
    load = win.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
  }
  void load.then(() => {
    if (!win.isDestroyed()) win.show();
  }).catch((error) => {
    log.error("main window document failed to load", { error: errorInfo(error) });
    // The queue has not necessarily hydrated yet. Closing this failed shell must
    // not flush an empty in-memory queue over the saved one.
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
// log; the app-authored dialog carries stable recovery guidance only.
async function reportStartupHalt(error: unknown): Promise<void> {
  log.error("startup halted", { error: errorInfo(error) });
  await notifyStartupFailure("startup.halted");
  app.exit(1);
}

function logLanguageError(error: unknown): void {
  log.warn("the interface language could not reach a native surface", { error: errorInfo(error) });
}

app.whenReady().then(async () => {
  // The language is settled before anything draws: the saved choice is read
  // straight from config.json so the menu that replaces Electron's default in
  // this same turn is already in it. The store's load below can still reset it.
  settleLanguage(readSavedPreference(readConfigText(settingsFile())), logLanguageError);
  installAppMenu(mainTranslator());
  onLanguageChanged(installAppMenu);
  log.info("app started", {
    version: APP_VERSION,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    logPath: log.path,
  });
  // Just-in-case data backup (data-backup conventions): write-through, not a startup scan. Each managed
  // text save records the exact bytes into `~/.zipkit/backups.sqlite3` strictly after its atomic rename
  // lands (see managedJson.ts's writeManagedJson + the backup store). There is nothing to kick off here.
  registerIpc();
  registerQueueIpc();

  // Warm stores before the renderer can save defaults over an unreadable file.
  // This also keeps failed quarantines on the startup error path. Each load
  // returns its own quarantine outcome; layout is disposable view state and its
  // recovery stays log-only.
  const settingsLoad = await loadSettings(log);
  const { quarantinedTo: settingsQuarantinedTo } = settingsLoad;
  // A missing or quarantined config is materialized immediately through the one
  // serializer/backup path before the renderer can observe or save settings.
  if (settingsLoad.missing || settingsQuarantinedTo) await saveSettings(settingsLoad.value);
  // The saved theme reaches the title bar, the renderer's prefers-color-scheme,
  // and the recovery dialogs before the window exists, so launch never shows the
  // OS appearance and then switches. A halt before this point follows the OS.
  applyThemePreference(settingsLoad.value.theme);
  followOsThemeChanges();
  // A quarantined or hand-edited file may settle on another language than the
  // raw read above; the store's value wins before the window opens.
  applyLanguagePreference(settingsLoad.value.language, logLanguageError);
  await loadLayout(log);

  windowCreationReady = true;
  const initialWindow = createWindow();
  if (activationPending) {
    activationPending = false;
    focusWindow(initialWindow);
  }
  // Queue recovery is material, so wait for it before reporting.
  const queueQuarantinedTo = await restoreQueue();

  for (const recoveryDialog of buildRecoveryDialogs({ settingsQuarantinedTo, queueQuarantinedTo })) {
    const { t } = mainTranslator();
    await showAppMessageDialog({
      owner: initialWindow,
      title: t(recoveryDialog.title),
      message: t(recoveryDialog.message),
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

let queueFlushedForQuit = false;
// Guards the async confirm/cancel decision below against a second `before-quit`
// (e.g. a repeated Cmd+Q) firing while the first is still awaiting the user or
// the running job's own abort.
let quitDecisionPending = false;
app.on("before-quit", (event) => {
  if (queueFlushedForQuit) return;
  event.preventDefault();
  if (quitDecisionPending) return;
  quitDecisionPending = true;
  void (async () => {
    try {
      // A job still writing, verifying, or moving originals to Trash has no
      // bounded way to finish on its own schedule, so quitting must choose:
      // cancel it (its writer removes its own temp file, within quit's bound)
      // or let the user keep working.
      if (hasRunningJob()) {
        const quitAnyway = await confirmQuitDuringWrite(getMainWindow());
        if (!quitAnyway) return; // quit stays cancelled; the job keeps running
      }
      await stopFlushAndExit({
        stopJob: cancelRunningJobAndWait,
        flush: flushQueue,
        onJobStopTimeout: () =>
          log.warn("the cancelled job did not stop in time; quitting without it", { waitMs: QUIT_WAIT_MS }),
        onFlushed: () => {
          queueFlushedForQuit = true;
          log.info("app quitting");
        },
        onFlushError: (err) => {
          queueFlushedForQuit = true;
          log.error("failed to flush the queue before quit", { error: errorInfo(err) });
        },
        exit: (code) => app.exit(code),
      });
    } finally {
      quitDecisionPending = false;
    }
  })();
});
