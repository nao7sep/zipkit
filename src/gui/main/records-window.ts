/**
 * The Records window shows `records.sqlite3`. It is a durable secondary window
 * with its own placement (window-conventions, Placement), and there is only ever
 * one: opening it again brings it forward.
 */

import { app, BrowserWindow, nativeTheme } from "electron";
import path from "node:path";
import { RECORDS_CHANGED_CHANNEL } from "../shared/api.js";
import { recordsWindowMinHeight, recordsWindowMinWidth } from "../shared/layout.js";
import { mainTranslator } from "./i18n.js";
import { errorInfo } from "./log.js";
import { loadRendererPage } from "./renderer-page.js";
import { log } from "./runtime.js";
import { configureWindowActivity } from "./windowActivity.js";
import { configureWindowMinimum } from "./window-minimum.js";
import { recordsWindowOptions } from "./window-options.js";
import { createWindowWithUsablePersistedBounds } from "./window-state-recovery.js";

let recordsWindow: BrowserWindow | null = null;
// The window still loading: a second open waits for it rather than showing a
// window whose page is not there yet.
let opening: Promise<void> | null = null;

function live(): BrowserWindow | null {
  return recordsWindow && !recordsWindow.isDestroyed() ? recordsWindow : null;
}

/** Tells the Records window, when it is open, that a record was stored. */
export function notifyRecordsChanged(): void {
  const window = live();
  if (window && !window.webContents.isDestroyed()) window.webContents.send(RECORDS_CHANGED_CHANNEL);
}

function bringForward(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export function openRecordsWindow(): Promise<void> {
  if (opening) return opening;
  const existing = live();
  if (existing) {
    bringForward(existing);
    return Promise.resolve();
  }

  const options = recordsWindowOptions(
    path.join(import.meta.dirname, "../preload/index.mjs"),
    nativeTheme.shouldUseDarkColors,
    mainTranslator().t("records.title"),
  );
  const window = createWindowWithUsablePersistedBounds("records", () => new BrowserWindow(options));
  recordsWindow = window;
  window.once("closed", () => {
    if (recordsWindow === window) recordsWindow = null;
  });
  configureWindowMinimum(window, () => ({ width: recordsWindowMinWidth(), height: recordsWindowMinHeight() }),
    (error) => log.warn("window minimum could not be updated", { window: "records", error: errorInfo(error) }));
  configureWindowActivity(app, window);
  log.info("records window created");

  const load = (async () => {
    try {
      await loadRendererPage(window, "records.html");
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
    if (!window.isDestroyed()) bringForward(window);
  })();
  opening = load;
  const settled = (): void => {
    if (opening === load) opening = null;
  };
  load.then(settled, settled);
  return load;
}
