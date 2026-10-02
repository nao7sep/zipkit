/**
 * Shared main-process singletons: the one `ZipKit` instance (one app run = one
 * SDK logging session), the app's own log (lifecycle + orchestration),
 * the target window for pushed streams, and the error mapper. Both the plain IPC
 * handlers and the queue engine use these.
 */

import { BrowserWindow } from "electron";
import { StallError, ZipKit, ZipKitError } from "../../sdk/index.js";
import type { GuiError, GuiLogEvent, Job } from "../shared/api.js";
import { message, type Message } from "../shared/i18n/translate.js";
import { createAppLog } from "./log.js";

export const zip = new ZipKit();

/** The app's log for this launch. The SDK keeps its own per-verb log file; the
 *  `zip.*` results' `log` field names it. */
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

/** Forward one job-tagged progress event to the renderer's Progress stream. */
export function sendEvent(event: GuiLogEvent): void {
  liveWindow()?.webContents.send("zipkit:event", event);
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
