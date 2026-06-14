/**
 * The IPC seam: each renderer call maps to one SDK verb (or, for the destructive
 * flow, a fixed gated sequence of them), mirroring the thin-wrapper rule the CLI
 * follows. The main process owns the `ZipKit` instance (one per app run = one
 * logging session), the native dialogs, the live plan + its inputs awaiting a
 * write, the cancellation controller, and the OS Trash. The SDK's event stream is
 * forwarded to the renderer so plan/write/verify progress, findings, and faults
 * appear live.
 */

import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { ZipKit, ZipKitError } from "../../sdk/index.js";
import type { ArchiveSpec, LogEvent } from "../../sdk/types.js";
import type {
  ArchiveAndTrashResult,
  GuiError,
  PlanData,
  PlanResult,
  VerifyResult,
  WriteResult,
} from "../shared/api.js";
import { outputInsideInputs } from "./safety.js";

let win: BrowserWindow | null = null;
/** Register the window the event stream is pushed to. */
export function setMainWindow(w: BrowserWindow): void {
  win = w;
}

const zip = new ZipKit();

/** The most recently planned archive plus the inputs it came from, held for a
 *  subsequent write (and, for the destructive flow, to know what to Trash). The
 *  plan carries the writer's out-of-band instructions, so the write happens here
 *  on this exact object — never on a copy round-tripped through IPC. */
let current: { plan: PlanData; inputs: string[] } | null = null;
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
      current = { plan, inputs: spec.inputs };
      return { ok: true, plan };
    } catch (err) {
      current = null;
      return { ok: false, error: toGuiError(err) };
    } finally {
      inFlight = null;
    }
  });

  ipcMain.handle("zipkit:write", async (): Promise<WriteResult> => {
    if (!current) {
      return { ok: false, error: { type: "unknown", code: "gui.no-plan", message: "Nothing planned to write." } };
    }
    inFlight = new AbortController();
    try {
      const data = await zip.write(current.plan, { signal: inFlight.signal, onProgress: forward });
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: toGuiError(err) };
    } finally {
      inFlight = null;
    }
  });

  ipcMain.handle(
    "zipkit:verify",
    async (_event, archive: string, checkMetadata: boolean): Promise<VerifyResult> => {
      inFlight = new AbortController();
      try {
        const data = await zip.extract(
          { archive, dryRun: true, checkMetadata },
          { signal: inFlight.signal, onProgress: forward },
        );
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: toGuiError(err) };
      } finally {
        inFlight = null;
      }
    },
  );

  ipcMain.handle("zipkit:archiveAndTrash", async (): Promise<ArchiveAndTrashResult> => {
    if (!current) return { ok: false, reason: "no-plan" };
    if (!current.plan.writable) return { ok: false, reason: "not-writable" };
    if (outputInsideInputs(current.plan.output, current.inputs)) {
      return { ok: false, reason: "unsafe-output" };
    }

    inFlight = new AbortController();
    const signal = inFlight.signal;
    try {
      let write;
      try {
        write = await zip.write(current.plan, { signal, onProgress: forward });
      } catch (err) {
        return { ok: false, reason: "write-failed", error: toGuiError(err) };
      }

      let verify;
      try {
        verify = await zip.extract(
          { archive: write.output, dryRun: true, checkMetadata: true },
          { signal, onProgress: forward },
        );
      } catch (err) {
        return { ok: false, reason: "verify-failed", error: toGuiError(err) };
      }
      if (!verify.reportOk) return { ok: false, reason: "verify-failed", verify };

      const trashed: string[] = [];
      try {
        for (const input of current.inputs) {
          await shell.trashItem(input);
          trashed.push(input);
        }
      } catch (err) {
        return { ok: false, reason: "trash-failed", error: toGuiError(err), output: write.output, trashed };
      }

      return { ok: true, output: write.output, bytes: write.bytes, trashed };
    } finally {
      inFlight = null;
    }
  });

  ipcMain.handle("zipkit:cancel", (): void => {
    inFlight?.abort();
  });
}
