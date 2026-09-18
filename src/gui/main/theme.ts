import { BrowserWindow, nativeTheme } from "electron";
import { normalizeThemePreference } from "../shared/spec.js";
import { mainWindowBackground } from "./window-options.js";

// Electron's nativeTheme.themeSource is ZipKit's one theme authority (app-chrome
// conventions, Theme): it paints the native title bar, menus, and dialogs, and it
// decides `prefers-color-scheme` in every renderer, which is what index.css's
// dark block and the app message dialog follow. No renderer resolves System
// itself.

/** The resolved theme's --bg, for a window's pre-paint background. */
export function windowBackground(dark: boolean = nativeTheme.shouldUseDarkColors): string {
  return mainWindowBackground(dark);
}

function syncWindowBackgrounds(): void {
  const color = windowBackground();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setBackgroundColor(color);
  }
}

/** Applies a saved choice to the whole app; System follows the OS. */
export function applyThemePreference(value: unknown): void {
  nativeTheme.themeSource = normalizeThemePreference(value);
  syncWindowBackgrounds();
}

/** Keeps window backgrounds in step when the OS appearance changes under System. */
export function followOsThemeChanges(): void {
  nativeTheme.on("updated", syncWindowBackgrounds);
}
