/**
 * Shared main-process singletons: the app's records
 * (lifecycle, orchestration, and every SDK event under its job),
 * the target window for pushed streams, and the error mapper. Both the plain IPC
 * handlers and the queue engine use these.
 */

import { BrowserWindow } from "electron";
import type { GuiError, Job, JobAction, JobEvent, LogEvent } from "../shared/api.js";
import { message, type Message } from "../shared/i18n/translate.js";
import { createAppLog } from "./log.js";

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

let lastRun = 0;

/** Start one Progress run for a job: the returned sink records each SDK event
 *  of that action under the job and one run id, then sends it to the window's
 *  Progress pane. The record is made whether or not a window is open: these
 *  records are the only durable copy of the SDK's events. Run ids count up in
 *  the launch, and a record's session tells launches apart. */
export function startProgressRun(jobId: string, action: JobAction): (event: LogEvent) => void {
  const run = String(++lastRun);
  return (event) => sendEvent(log.jobEvent(jobId, event, action, run));
}

// Progress reaches the window in batches, one message and one render however
// fast a run reports, as a folder that flags every file does (volume-handling
// conventions, Item count). Short enough to read as live.
export const EVENT_BATCH_MS = 50;
let pendingEvents: JobEvent[] = [];
let eventsTimer: ReturnType<typeof setTimeout> | undefined;

function sendEvent(recorded: JobEvent): void {
  pendingEvents.push(recorded);
  eventsTimer ??= setTimeout(() => {
    eventsTimer = undefined;
    const batch = pendingEvents;
    pendingEvents = [];
    liveWindow()?.webContents.send("zipkit:events", batch);
  }, EVENT_BATCH_MS);
}

export function sendQueue(jobs: Job[]): void {
  liveWindow()?.webContents.send("zipkit:queue", jobs);
}

/** Tell the window whether the latest queue save succeeded. */
export function sendQueueSaved(saved: boolean): void {
  liveWindow()?.webContents.send("zipkit:queueSaved", saved);
}

/** SDK failures reach main from the SDK host as plain fields (./sdk-client). */
export function toGuiError(err: unknown): GuiError {
  const fields = (err ?? {}) as { errorType?: unknown; code?: unknown; path?: unknown };
  if (typeof fields.errorType !== "string" || typeof fields.code !== "string") {
    return { type: "unknown", code: "unknown", presentation: guiErrorPresentation("unknown") };
  }
  if (fields.errorType === "stall" && typeof fields.path === "string") {
    return { type: fields.errorType, code: fields.code, presentation: message("error.stalled", { path: fields.path }) };
  }
  if (fields.code === "host.exited") return { type: fields.errorType, code: fields.code, presentation: message("error.hostExited") };
  return { type: fields.errorType, code: fields.code, presentation: guiErrorPresentation(fields.errorType) };
}

function guiErrorPresentation(type: string): Message {
  return message(type === "read" ? "error.readFailed" : "error.verifyIncomplete");
}
