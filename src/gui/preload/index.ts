/**
 * The preload bridge: exposes the typed `window.zipkit` surface to the renderer.
 * Each method is a one-line `ipcRenderer.invoke` to the matching main-process
 * channel; `onEvent` subscribes to the pushed SDK event stream and returns an
 * unsubscribe. Held to the shared `ZipKitGuiApi` interface via `satisfies`, so
 * the bridge and its declared type cannot drift.
 */

import { contextBridge, ipcRenderer } from "electron";
import type {
  ArchiveAndTrashResult,
  ArchiveSpec,
  LogEvent,
  PlanResult,
  VerifyResult,
  WriteResult,
  ZipKitGuiApi,
} from "../shared/api.js";

const api = {
  chooseInputs: (): Promise<string[]> => ipcRenderer.invoke("zipkit:chooseInputs"),
  plan: (spec: ArchiveSpec): Promise<PlanResult> => ipcRenderer.invoke("zipkit:plan", spec),
  write: (): Promise<WriteResult> => ipcRenderer.invoke("zipkit:write"),
  verify: (archive: string, checkMetadata: boolean): Promise<VerifyResult> =>
    ipcRenderer.invoke("zipkit:verify", archive, checkMetadata),
  archiveAndTrash: (): Promise<ArchiveAndTrashResult> => ipcRenderer.invoke("zipkit:archiveAndTrash"),
  cancel: (): Promise<void> => ipcRenderer.invoke("zipkit:cancel"),
  onEvent: (callback: (event: LogEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: LogEvent): void => callback(event);
    ipcRenderer.on("zipkit:event", handler);
    return () => {
      ipcRenderer.removeListener("zipkit:event", handler);
    };
  },
} satisfies ZipKitGuiApi;

contextBridge.exposeInMainWorld("zipkit", api);
