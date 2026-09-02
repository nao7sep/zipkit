import type { App, BrowserWindow } from "electron";
import { WINDOW_ACTIVITY_CHANNEL } from "../shared/api.js";

/**
 * Projects native app and window activation into the renderer. On macOS both
 * Chromium DOM focus and BrowserWindow.isFocused() can remain true after the
 * application resigns active status, so the NSApplication-backed Electron app
 * events own that half of the state. BrowserWindow focus still distinguishes an
 * inactive owner window from another window inside the active app.
 */
export function configureWindowActivity(application: App, window: BrowserWindow): void {
  let applicationActive = true;
  let windowFocused = window.isFocused();

  const send = (): void => {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(WINDOW_ACTIVITY_CHANNEL, applicationActive && windowFocused);
    }
  };
  const onApplicationActive = (): void => {
    applicationActive = true;
    windowFocused = window.isFocused();
    send();
  };
  const onApplicationInactive = (): void => {
    applicationActive = false;
    send();
  };

  application.on("did-become-active", onApplicationActive);
  application.on("did-resign-active", onApplicationInactive);
  window.on("focus", () => {
    windowFocused = true;
    send();
  });
  window.on("blur", () => {
    windowFocused = false;
    send();
  });
  window.webContents.on("did-finish-load", send);
  window.once("closed", () => {
    application.removeListener("did-become-active", onApplicationActive);
    application.removeListener("did-resign-active", onApplicationInactive);
  });
}
