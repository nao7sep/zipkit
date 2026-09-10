import type { BrowserWindowConstructorOptions } from "electron";
import { minWindowHeight, minWindowWidth } from "../shared/layout.js";

/**
 * Build the durable main window's options without constructing a native window.
 * Electron owns bounds persistence for the stable window identity; the designed
 * opening size remains the fallback when no usable saved bounds exist.
 */
export function mainWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    name: "main",
    windowStatePersistence: { bounds: true, displayMode: false },
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
    // Must mirror the renderer's --bg token (index.css). The main process can't
    // read CSS vars, so this literal is the one place the theme bg is duplicated;
    // keep them in sync so the pre-paint/resize edge doesn't flash a stale color.
    backgroundColor: "#16170f",
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
