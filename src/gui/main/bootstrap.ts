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

import { app, BrowserWindow, nativeTheme, screen } from "electron";
import path from "node:path";
import { installContentSecurityPolicy } from "./csp.js";
import { buildRecoveryDialogs } from "./recoveryDialogs.js";
import { isLoopbackRendererUrl, isSameOrigin, windowOpenHandler } from "./navigation.js";
import { registerIpc } from "./ipc.js";
import { flushQueue, registerQueueIpc, restoreQueue } from "./queue.js";
import { loadSettings, saveSettings } from "./settings.js";
import { errorInfo } from "./log.js";
import { clearMainWindow, ensureMainWindow, getMainWindow, log } from "./runtime.js";
import { minWindowHeight, minWindowWidth } from "../shared/layout.js";
import { getWindowPlacement, loadLayout, saveWindowPlacement } from "./layout.js";
import { notifyStartupFailure, showAppMessageDialog } from "./startup-dialog.js";
import { configureWindowActivity } from "./windowActivity.js";
import { initializeWindowPlacement, configureWindowPlacement, resolveWindowRestoration } from "./windowPlacement.js";
import { flushThenExit } from "./quit.js";
import { configureWindowMinimum } from "./window-minimum.js";

let flushMainWindowPlacement: (() => Promise<void>) | null = null;

// Last-resort hooks: record the failure before the process can die. The session
// log appends synchronously, so the line is on disk by the time these return.
process.on("uncaughtException", (err) => {
  log.error("uncaught exception", { error: errorInfo(err) });
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { error: errorInfo(reason) });
});

function createWindow(): BrowserWindow {
  const owned = ensureMainWindow(() => new BrowserWindow({
    // Opening size: comfortable for the default layout — the dense center Archive
    // pane (inputs + the options grid + operation + report all stack here) gets
    // ~550px wide and the body ~710px tall, so the common case opens roomy without
    // a huge window. The user can resize/drag from here; nothing is persisted.
    width: 1200,
    height: 780,
    // Content-based minimum, DERIVED from the pane minimums + fixed chrome in
    // shared/layout.ts (window-chrome convention) — never a hand-typed literal,
    // so the window can never be shrunk below the panes' real minimums and
    // truncate content. minWidth reserves both side columns + the center Archive
    // minimum + splitters + body padding; minHeight reserves the header and a
    // usable body below it.
    minWidth: minWindowWidth(),
    minHeight: minWindowHeight(),
    show: false,
    // Must mirror the renderer's --bg token (index.css). The main process can't
    // read CSS vars, so this literal is the one place the theme bg is duplicated;
    // keep them in sync so the pre-paint/resize edge doesn't flash a stale color.
    backgroundColor: "#16170f",
    webPreferences: {
      preload: path.join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // The package is ESM, so electron-vite emits an ESM (.mjs) preload, which
      // Electron only loads with the sandbox off. contextIsolation still keeps the
      // renderer walled off from Node; the bridge is the sole crossing.
      sandbox: false,
    },
  }));
  const win = owned.window;
  if (!owned.created) return win;
  configureWindowActivity(app, win);

  let workAreas: Electron.Rectangle[] = [];
  try { workAreas = screen.getAllDisplays().map((display) => display.workArea); }
  catch (error) { log.warn("display work areas unavailable; using opening window bounds", { error: errorInfo(error) }); }
  const savedPlacement = getWindowPlacement();
  const placementError = (error: unknown): void => {
    log.warn("window placement operation failed", { error: errorInfo(error) });
  };
  const restoration = resolveWindowRestoration(
    savedPlacement,
    { width: minWindowWidth(), height: minWindowHeight() },
    workAreas,
  );
  configureWindowMinimum(win, () => ({ width: minWindowWidth(), height: minWindowHeight() }),
    (error) => log.warn("window minimum could not be updated", { error: errorInfo(error) }));
  const { initial, windows: windowsPlacement } = initializeWindowPlacement(win, savedPlacement, restoration, placementError);
  const placement = configureWindowPlacement(
    win,
    initial,
    saveWindowPlacement,
    placementError,
    windowsPlacement,
  );
  const flushThisPlacement = () => placement.flush();
  flushMainWindowPlacement = flushThisPlacement;
  let closeAllowed = false;
  win.on("close", (event) => {
    if (closeAllowed) return;
    event.preventDefault();
    void placement.flush().finally(() => {
      if (win.isDestroyed()) return;
      closeAllowed = true;
      win.close();
    });
  });
  win.on("session-end", () => { void placement.flush(); });

  let flushQueueOnClose = true;
  win.on("closed", () => {
    placement.dispose();
    if (flushMainWindowPlacement === flushThisPlacement) flushMainWindowPlacement = null;
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
    win.show();
    // Windows requires a native event-loop turn between show and maximize.
    setTimeout(() => {
      if (win.isDestroyed()) return;
      placement.start();
      if (restoration.mode === "maximized") {
        try { win.maximize(); }
        catch (error) { log.warn("window could not be maximized during restoration", { error: errorInfo(error) }); }
      }
    }, 0);
  }).catch((error) => {
    log.error("main window document failed to load", { error: errorInfo(error) });
    // The queue has not necessarily hydrated yet. Closing this failed shell must
    // not flush an empty in-memory queue over the saved one.
    flushQueueOnClose = false;
    if (!win.isDestroyed()) win.close();
    void notifyStartupFailure(
      "ZipKit could not load its window. Restart it. Your source files and archives are unchanged.",
    ).catch((dialogError) => log.error("window load failure dialog failed", { error: errorInfo(dialogError) }));
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
  await notifyStartupFailure(
    "ZipKit stopped before opening its window. Restart it. If the problem continues, check the ZipKit log for the diagnostic. Your archive files on disk are not affected.",
  );
  app.exit(1);
}

app.whenReady().then(async () => {
  log.info("app started", {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    logPath: log.path,
  });
  // ZipKit is a dark app; force the OS chrome (the native title bar on macOS) to
  // dark so it matches the UI rather than following the system appearance — a
  // light title bar on a dark app is the window-chrome convention's prime example
  // of OS-default chrome fighting the app. Set before the window is created.
  nativeTheme.themeSource = "dark";
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
    await showAppMessageDialog({
      owner: initialWindow,
      title: recoveryDialog.title,
      message: recoveryDialog.message,
      buttonLabel: "OK",
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
app.on("before-quit", (event) => {
  if (queueFlushedForQuit) return;
  event.preventDefault();
  void flushThenExit(
    [flushQueue(), flushMainWindowPlacement?.()],
    () => {
      queueFlushedForQuit = true;
      log.info("app quitting");
    },
    (err) => {
      queueFlushedForQuit = true;
      log.error("failed to flush the queue before quit", { error: errorInfo(err) });
    },
    (code) => app.exit(code),
  );
});
