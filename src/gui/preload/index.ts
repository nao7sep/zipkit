/**
 * The preload bridge: exposes the typed `window.zipkit` surface to the renderer.
 * Each method is a one-line `ipcRenderer.invoke`/subscription to the matching
 * main-process channel. Held to the shared `ZipKitGuiApi` interface via
 * `satisfies`, so the bridge and its declared type cannot drift.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { GuiOptions } from "../shared/spec.js";
import type { PaneLayout } from "../shared/layout.js";
import type { AppInfo, GuiLogEvent, Job, JobIntent, PlanData, VerifyResult, ZipKitGuiApi } from "../shared/api.js";

const api = {
  chooseInputs: (): Promise<string[]> => ipcRenderer.invoke("zipkit:chooseInputs"),
  chooseOutputDir: (): Promise<string> => ipcRenderer.invoke("zipkit:chooseOutputDir"),
  getSettings: (): Promise<GuiOptions> => ipcRenderer.invoke("zipkit:getSettings"),
  setSettings: (defaults: GuiOptions): Promise<void> =>
    ipcRenderer.invoke("zipkit:setSettings", defaults),
  getLayout: (): Promise<PaneLayout> => ipcRenderer.invoke("zipkit:getLayout"),
  setLayout: (layout: PaneLayout): Promise<void> => ipcRenderer.invoke("zipkit:setLayout", layout),
  addJob: (inputs: string[], options: GuiOptions, intent: JobIntent): Promise<string> =>
    ipcRenderer.invoke("zipkit:addJob", inputs, options, intent),
  updateJob: (
    id: string,
    patch: { options?: GuiOptions; intent?: JobIntent; inputs?: string[] },
  ): Promise<void> => ipcRenderer.invoke("zipkit:updateJob", id, patch),
  removeJob: (id: string): Promise<void> => ipcRenderer.invoke("zipkit:removeJob", id),
  runJob: (id: string): Promise<void> => ipcRenderer.invoke("zipkit:runJob", id),
  removeArchive: (id: string): Promise<void> => ipcRenderer.invoke("zipkit:removeArchive", id),
  trashOriginals: (id: string): Promise<void> => ipcRenderer.invoke("zipkit:trashOriginals", id),
  cancelJob: (id: string): Promise<void> => ipcRenderer.invoke("zipkit:cancelJob", id),
  getPlan: (id: string): Promise<PlanData | null> => ipcRenderer.invoke("zipkit:getPlan", id),
  getQueue: (): Promise<Job[]> => ipcRenderer.invoke("zipkit:getQueue"),
  onQueue: (callback: (jobs: Job[]) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, jobs: Job[]): void => callback(jobs);
    ipcRenderer.on("zipkit:queue", handler);
    return () => {
      ipcRenderer.removeListener("zipkit:queue", handler);
    };
  },
  verify: (jobId: string, archive: string, checkMetadata: boolean): Promise<VerifyResult> =>
    ipcRenderer.invoke("zipkit:verify", jobId, archive, checkMetadata),
  reveal: (path: string): void => {
    void ipcRenderer.invoke("zipkit:reveal", path);
  },
  onEvent: (callback: (event: GuiLogEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: GuiLogEvent): void => callback(event);
    ipcRenderer.on("zipkit:event", handler);
    return () => {
      ipcRenderer.removeListener("zipkit:event", handler);
    };
  },
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke("zipkit:appInfo"),
  openExternal: (url: string): void => {
    void ipcRenderer.invoke("zipkit:openExternal", url);
  },
} satisfies ZipKitGuiApi;

contextBridge.exposeInMainWorld("zipkit", api);
