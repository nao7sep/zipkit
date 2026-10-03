/**
 * Loads one of the renderer's pages into a window: the electron-vite dev server's
 * page in development, the built file in production. Every window gets the same
 * navigation guard (defense-in-depth alongside the CSP): it opens no child
 * windows and never leaves its own page's origin.
 */

import { app, type BrowserWindow } from "electron";
import path from "node:path";
import { installContentSecurityPolicy } from "./csp.js";
import { isLoopbackRendererUrl, isSameOrigin, windowOpenHandler } from "./navigation.js";

export type RendererPage = "index.html" | "records.html";

/** Throws at once for an unusable dev-server URL; the returned load rejects
 *  when the page fails to load. */
export function loadRendererPage(win: BrowserWindow, page: RendererPage): Promise<void> {
  win.webContents.setWindowOpenHandler(windowOpenHandler);
  win.webContents.on("will-navigate", (event, url) => {
    if (!isSameOrigin(win.webContents.getURL(), url)) event.preventDefault();
  });

  const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    if (!isLoopbackRendererUrl(devUrl)) {
      throw new Error("ELECTRON_RENDERER_URL must be an HTTP(S) loopback URL");
    }
    return win.loadURL(new URL(page, devUrl.endsWith("/") ? devUrl : `${devUrl}/`).toString());
  }
  // Production path only (run-built / rebuild): enforce the strict CSP via a
  // response header before loading the file. Dev leaves the policy unset so
  // electron-vite's HMR keeps working. Registering it again for a later window
  // replaces the one handler.
  installContentSecurityPolicy();
  return win.loadFile(path.join(import.meta.dirname, "../renderer", page));
}
