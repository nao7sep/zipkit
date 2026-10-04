/**
 * Shared main-process singletons: the one `ZipKit` instance, the app's records
 * (lifecycle, orchestration, and every SDK event under its job),
 * the target window for pushed streams, and the error mapper. Both the plain IPC
 * handlers and the queue engine use these.
 */

import { BrowserWindow } from "electron";
import { StallError, ZipKit, ZipKitError } from "../../sdk/index.js";
import type { GuiError, Job, LogEvent } from "../shared/api.js";
import { message, type Message } from "../shared/i18n/translate.js";
import { createAppLog } from "./log.js";

/** Every `zip.*` call passes an `onProgress` that records its events in
 *  `records.sqlite3` (see {@link sendEvent}), so the SDK's own session log file
 *  would only duplicate them; the results' `log` is therefore `null`. */
export const zip = new ZipKit({ sessionLog: false });

/** The app's records for this launch. */
export const log = createAppLog();

let win: BrowserWindow | null = null;
export function setMainWindow(w: BrowserWindow | null): void {
  win = w;
}
/** Return the live owner or create and install it exactly once. */
export function ensureMainWindow(create: () => BrowserWindow): {
  window: BrowserWindow;
  created: boolean;
} {
  const current = getMainWindow();
  if (current) return { window: current, created: false };
  const created = create();
  win = created;
  return { window: created, created: true };
}
/** Clear only the window that actually closed; a stale close callback must not
 * erase a replacement window installed after it. */
export function clearMainWindow(closed: BrowserWindow): void {
  if (win === closed) win = null;
}
export function getMainWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

function liveWindow(): BrowserWindow | null {
  const current = getMainWindow();
  if (!current || current.webContents.isDestroyed()) return null;
  return current;
}

/** Record one SDK progress event under its job, then send it to the window's
 *  Progress pane. The record is made whether or not a window is open: these
 *  records are the only durable copy of the SDK's events. */
export function sendEvent(jobId: string, event: LogEvent): void {
  const recorded = log.jobEvent(jobId, event);
  liveWindow()?.webContents.send("zipkit:event", recorded);
}

export function sendQueue(jobs: Job[]): void {
  liveWindow()?.webContents.send("zipkit:queue", jobs);
}

export function toGuiError(err: unknown): GuiError {
  if (err instanceof StallError) {
    return { type: err.errorType, code: err.code, presentation: message("error.stalled", { path: err.path }) };
  }
  if (err instanceof ZipKitError) {
    return { type: err.errorType, code: err.code, presentation: guiErrorPresentation(err.errorType) };
  }
  return { type: "unknown", code: "unknown", presentation: guiErrorPresentation("unknown") };
}

function guiErrorPresentation(type: string): Message {
  return message(type === "read" ? "error.readFailed" : "error.verifyIncomplete");
}
