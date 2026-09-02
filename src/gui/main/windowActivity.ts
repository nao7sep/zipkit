import type { BrowserWindow } from "electron";
import { WINDOW_ACTIVITY_CHANNEL } from "../shared/api.js";

/**
 * Projects the platform BrowserWindow's activation into the renderer. Chromium
 * can retain DOM focus while another macOS application is active, so only the
 * native focus/blur events own inactive-window presentation. The load event
 * seeds a fresh or reloaded renderer with the current native state.
 */
export function configureWindowActivity(window: BrowserWindow): void {
  const send = (active: boolean): void => {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(WINDOW_ACTIVITY_CHANNEL, active);
    }
  };
  window.on("focus", () => send(true));
  window.on("blur", () => send(false));
  window.webContents.on("did-finish-load", () => send(window.isFocused()));
}
