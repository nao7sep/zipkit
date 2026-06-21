/**
 * Shared main-process singletons: the one `ZipKit` instance (one app run = one
 * SDK logging session), the app's own session log (lifecycle + orchestration),
 * the target window for pushed streams, and the error mapper. Both the plain IPC
 * handlers and the queue engine use these.
 */

import { BrowserWindow } from "electron";
import { ZipKit, ZipKitError } from "../../sdk/index.js";
import type { GuiError, GuiLogEvent, Job } from "../shared/api.js";
import { createAppLog } from "./log.js";

export const zip = new ZipKit();

/** The app's session log for this launch. The SDK keeps its own per-verb log; the
 *  `zip.*` results' `log` field names that companion file. */
export const log = createAppLog();

let win: BrowserWindow | null = null;
export function setMainWindow(w: BrowserWindow): void {
  win = w;
}

/** Forward one job-tagged progress event to the renderer's Progress stream. */
export function sendEvent(event: GuiLogEvent): void {
  win?.webContents.send("zipkit:event", event);
}

export function sendQueue(jobs: Job[]): void {
  win?.webContents.send("zipkit:queue", jobs);
}

export function toGuiError(err: unknown): GuiError {
  if (err instanceof ZipKitError) {
    return { type: err.errorType, code: err.code, message: err.message };
  }
  return { type: "unknown", code: "unknown", message: err instanceof Error ? err.message : String(err) };
}
