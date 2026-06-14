/**
 * The Electron main process: create the window, register the IPC seam (plain
 * handlers + the queue engine), and load the renderer (the electron-vite dev
 * server in development, the built file in production). The app is the primary
 * face of ZipKit; the SDK is driven from here.
 */

import { app, BrowserWindow } from "electron";
import path from "node:path";
import { registerIpc } from "./ipc.js";
import { registerQueueIpc, restoreQueue } from "./queue.js";
import { setMainWindow } from "./runtime.js";

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#1a1a1a",
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

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  registerIpc();
  registerQueueIpc();
  createWindow();
  void restoreQueue();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
