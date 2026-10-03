import type { BrowserWindowConstructorOptions } from "electron";
import { minWindowHeight, minWindowWidth, recordsWindowMinHeight, recordsWindowMinWidth } from "../shared/layout.js";

/** The renderer's --bg token (index.css) in each theme. The main process can't
 *  read CSS vars, so these literals are the one place the theme bg is duplicated;
 *  keep them in sync so the pre-paint/resize edge doesn't flash a stale color. */
export function mainWindowBackground(dark: boolean): string {
  return dark ? "#16170f" : "#f3f2ea";
}

/**
 * Build the durable main window's options without constructing a native window.
 * Electron owns bounds persistence for the stable window identity; the designed
 * opening size remains the fallback when no usable saved bounds exist.
 */
export function mainWindowOptions(preload: string, dark: boolean): BrowserWindowConstructorOptions {
  return {
    name: "main",
    windowStatePersistence: {
      bounds: true,
      displayMode: process.platform === "win32",
    },
    // Opening size: comfortable for the default layout — the dense center Archive
    // pane (inputs + the options grid + operation + report all stack here) gets
    // ~550px wide and the body ~710px tall, so the common case opens roomy without
    // a huge window.
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
    // The resolved theme's --bg, so the first frame matches the page.
    backgroundColor: mainWindowBackground(dark),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      // The package is ESM, so electron-vite emits an ESM (.mjs) preload, which
      // Electron only loads with the sandbox off. contextIsolation still keeps the
      // renderer walled off from Node; the bridge is the sole crossing.
      sandbox: false,
    },
  };
}

/**
 * The Records window's options: a durable secondary window with its own stable
 * identity, so Electron persists its placement apart from the main window's
 * (window-conventions, Placement). Like the main window it starts hidden and is
 * shown once its page has loaded.
 */
export function recordsWindowOptions(preload: string, dark: boolean, title: string): BrowserWindowConstructorOptions {
  return {
    name: "records",
    windowStatePersistence: {
      bounds: true,
      displayMode: process.platform === "win32",
    },
    title,
    width: 1240,
    height: 820,
    minWidth: recordsWindowMinWidth(),
    minHeight: recordsWindowMinHeight(),
    show: false,
    backgroundColor: mainWindowBackground(dark),
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      // The same ESM preload as the main window; see mainWindowOptions.
      sandbox: false,
    },
  };
}
