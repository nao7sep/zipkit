/**
 * Shared main-process singletons: the one `ZipKit` instance (one app run = one
 * logging session), the target window for pushed streams, and the error mapper.
 * Both the plain IPC handlers and the queue engine use these.
 */

import { BrowserWindow } from "electron";
import { ZipKit, ZipKitError } from "../../sdk/index.js";
import type { LogEvent } from "../../sdk/types.js";
import type { GuiError, Job } from "../shared/api.js";

export const zip = new ZipKit();

let win: BrowserWindow | null = null;
export function setMainWindow(w: BrowserWindow): void {
  win = w;
}

export function forwardEvent(event: LogEvent): void {
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
