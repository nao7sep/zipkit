/**
 * The IPC seam: each renderer call maps to exactly one SDK verb, mirroring the
 * thin-wrapper rule the CLI follows. The main process owns the `ZipKit` instance
 * (one per app run = one logging session), the native dialogs, the live plan
 * awaiting a write, and the cancellation controller. The SDK's event stream is
 * forwarded to the renderer over a push channel so plan/write progress, findings,
 * and faults appear live.
 */

import { BrowserWindow, dialog, ipcMain } from "electron";
import { ZipKit, ZipKitError } from "../../sdk/index.js";
import type { ArchiveSpec, LogEvent } from "../../sdk/types.js";
import type { GuiError, PlanData, PlanResult, WriteResult } from "../shared/api.js";

let win: BrowserWindow | null = null;
/** Register the window the event stream is pushed to. */
export function setMainWindow(w: BrowserWindow): void {
  win = w;
}

const zip = new ZipKit();

/** The most recently planned archive, held for a subsequent `write`. It carries
 *  the writer's out-of-band instructions, so the write happens here on this exact
 *  object — never on a copy round-tripped through IPC. */
let currentPlan: PlanData | null = null;
/** The controller for the in-flight verb, or null when idle. */
let inFlight: AbortController | null = null;

function toGuiError(err: unknown): GuiError {
  if (err instanceof ZipKitError) {
    return { type: err.errorType, code: err.code, message: err.message };
  }
  return {
    type: "unknown",
    code: "unknown",
    message: err instanceof Error ? err.message : String(err),
  };
}

function forward(event: LogEvent): void {
  win?.webContents.send("zipkit:event", event);
}

export function registerIpc(): void {
  ipcMain.handle("zipkit:chooseInputs", async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      title: "Choose folders or files to archive",
      properties: ["openDirectory", "openFile", "multiSelections"],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("zipkit:plan", async (_event, spec: ArchiveSpec): Promise<PlanResult> => {
    inFlight = new AbortController();
    try {
      const plan = await zip.plan(spec, { signal: inFlight.signal, onProgress: forward });
      currentPlan = plan;
      return { ok: true, plan };
    } catch (err) {
      currentPlan = null;
      return { ok: false, error: toGuiError(err) };
    } finally {
      inFlight = null;
    }
  });

  ipcMain.handle("zipkit:write", async (): Promise<WriteResult> => {
    if (!currentPlan) {
      return { ok: false, error: { type: "unknown", code: "gui.no-plan", message: "Nothing planned to write." } };
    }
    inFlight = new AbortController();
    try {
      const data = await zip.write(currentPlan, { signal: inFlight.signal, onProgress: forward });
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: toGuiError(err) };
    } finally {
      inFlight = null;
    }
  });

  ipcMain.handle("zipkit:cancel", (): void => {
    inFlight?.abort();
  });
}
