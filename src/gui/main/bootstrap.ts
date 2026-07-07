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
import path from "node:path";
import { installContentSecurityPolicy } from "./csp.js";
import { isSameOrigin, windowOpenHandler } from "./navigation.js";
import { registerIpc } from "./ipc.js";
import { registerQueueIpc, restoreQueue } from "./queue.js";
import { ensureSettingsFile } from "./settings.js";
import { errorInfo } from "./log.js";
import { log, setMainWindow } from "./runtime.js";
import { minWindowHeight, minWindowWidth } from "../shared/layout.js";

// Last-resort hooks: record the failure before the process can die. The session
// log appends synchronously, so the line is on disk by the time these return.
process.on("uncaughtException", (err) => {
  log.error("uncaught exception", { error: errorInfo(err) });
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { error: errorInfo(reason) });
});

function createWindow(): void {
  const win = new BrowserWindow({
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
  });

  setMainWindow(win);
  log.info("main window created");

  // Navigation guard (defense-in-depth alongside the CSP): the SPA stays on its
  // own origin and opens no child windows, so deny every renderer-initiated
  // window open and prevent any navigation that would leave the loaded origin.
  // Same-origin navigation (reloads / in-app routing) is left to proceed.
  win.webContents.setWindowOpenHandler(windowOpenHandler);
  win.webContents.on("will-navigate", (event, url) => {
    if (!isSameOrigin(win.webContents.getURL(), url)) event.preventDefault();
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    // Production path only (run-built / rebuild): enforce the strict CSP via a
    // response header before loading the file. Dev leaves the policy unset so
    // electron-vite's HMR keeps working.
    installContentSecurityPolicy();
    void win.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
  }
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
  // Create config.json from the built-in defaults on first run so the settings file exists on disk
  // immediately, not only after the first save (storage-path conventions). Create-if-absent, and
  // before the window/renderer reads settings over IPC; a write failure is logged, not fatal.
  try {
    await ensureSettingsFile();
  } catch (err) {
    log.error("failed to create config.json on first run", { error: errorInfo(err) });
  }
  // Just-in-case data backup (data-backup conventions): write-through, not a startup scan. Each managed
  // text save records the exact bytes into `~/.zipkit/backups.sqlite3` strictly after its atomic rename
  // lands (see managedJson.ts's writeManagedJson + the backup store). There is nothing to kick off here.
  registerIpc();
  registerQueueIpc();
  createWindow();
  void restoreQueue();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  const quitting = process.platform !== "darwin";
  log.info("all windows closed", { quitting });
  if (quitting) app.quit();
});

app.on("before-quit", () => {
  log.info("app quitting");
});
