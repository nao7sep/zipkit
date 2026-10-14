import { BrowserWindow, nativeTheme, systemPreferences } from "electron";
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

/** What the System theme resolves to now, from what each platform reports.
 *  Electron gives the OS appearance only while the app follows it; under a forced
 *  theme macOS still keeps it in AppleInterfaceStyle, and Windows reports its
 *  system theme, which in Windows' Custom mode can differ from its app mode. */
export function resolveSystemAppearance(probe: {
  following: boolean;
  dark: boolean;
  platform: NodeJS.Platform;
  macInterfaceStyle: () => string;
  systemUiDark: boolean;
}): "light" | "dark" {
  if (probe.following) return probe.dark ? "dark" : "light";
  if (probe.platform === "darwin") return probe.macInterfaceStyle() === "Dark" ? "dark" : "light";
  return probe.systemUiDark ? "dark" : "light";
}

export function systemAppearance(): "light" | "dark" {
  return resolveSystemAppearance({
    following: nativeTheme.themeSource === "system",
    dark: nativeTheme.shouldUseDarkColors,
    platform: process.platform,
    macInterfaceStyle: () => systemPreferences.getUserDefault("AppleInterfaceStyle", "string"),
    systemUiDark: nativeTheme.shouldUseDarkColorsForSystemIntegratedUI,
  });
}
