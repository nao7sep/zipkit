/**
 * The preload bridge: exposes the typed `window.zipkit` surface to the renderer.
 * Each method is a one-line `ipcRenderer.invoke`/subscription to the matching
 * main-process channel. Held to the shared `ZipKitGuiApi` interface via
 * `satisfies`, so the bridge and its declared type cannot drift.
 */

import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { GuiOptions, GuiSettings } from "../shared/spec.js";
import type { PaneLayout } from "../shared/layout.js";
import type { RecordDetail, RecordKind, RecordSources, RecordsPage, RecordsQuery } from "../shared/records.js";
import { LANGUAGE_CHANGED_CHANNEL, RECORDS_CHANGED_CHANNEL, WINDOW_ACTIVITY_CHANNEL, type AppInfo, type LanguageEnvironment, type JobEvent, type GuiReportedError, type Job, type JobIntent, type PlanData, type VerifyResult, type ZipKitGuiApi } from "../shared/api.js";

const api = {
  chooseInputs: (): Promise<string[]> => ipcRenderer.invoke("zipkit:chooseInputs"),
  chooseOutputDir: (): Promise<string> => ipcRenderer.invoke("zipkit:chooseOutputDir"),
  // The absolute path for a drag-dropped File (Electron 32+ removed File.path, so
  // this is the supported route). Synchronous, no IPC — webUtils runs in preload.
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  // The host OS, read synchronously in preload (no IPC) so the renderer can
  // display the running platform's modifier word in the shortcuts dialog.
  platform: process.platform,
  onWindowActivityChanged: (callback: (active: boolean) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, active: boolean): void => {
      if (typeof active === "boolean") callback(active);
    };
    ipcRenderer.on(WINDOW_ACTIVITY_CHANNEL, handler);
    return () => ipcRenderer.removeListener(WINDOW_ACTIVITY_CHANNEL, handler);
  },
  getLanguageEnvironment: (): Promise<LanguageEnvironment> => ipcRenderer.invoke("zipkit:getLanguageEnvironment"),
  onLanguageChanged: (callback: (environment: LanguageEnvironment) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, environment: LanguageEnvironment): void => callback(environment);
    ipcRenderer.on(LANGUAGE_CHANGED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(LANGUAGE_CHANGED_CHANNEL, handler);
  },
  onSettingsChanged: (callback: (settings: GuiSettings) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, settings: GuiSettings) => callback(settings);
    ipcRenderer.on("zipkit:settingsChanged", listener);
    return () => { ipcRenderer.removeListener("zipkit:settingsChanged", listener); };
  },
  discardSettingsSubmission: (): Promise<void> => ipcRenderer.invoke("zipkit:discardSettingsSubmission"),
  getSettings: (): Promise<GuiSettings> => ipcRenderer.invoke("zipkit:getSettings"),
  setSettings: (settings: GuiSettings): Promise<GuiSettings> =>
    ipcRenderer.invoke("zipkit:setSettings", settings),
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
  onQueueSaved: (callback: (saved: boolean) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, saved: boolean): void => callback(saved);
    ipcRenderer.on("zipkit:queueSaved", handler);
    return () => {
      ipcRenderer.removeListener("zipkit:queueSaved", handler);
    };
  },
  verify: (jobId: string, archive: string, checkMetadata: boolean): Promise<VerifyResult> =>
    ipcRenderer.invoke("zipkit:verify", jobId, archive, checkMetadata),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke("zipkit:reveal", path),
  getJobEvents: (jobId: string): Promise<JobEvent[]> => ipcRenderer.invoke("zipkit:getJobEvents", jobId),
  onEvent: (callback: (event: JobEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: JobEvent): void => callback(event);
    ipcRenderer.on("zipkit:event", handler);
    return () => {
      ipcRenderer.removeListener("zipkit:event", handler);
    };
  },
  openRecordsWindow: (): Promise<void> => ipcRenderer.invoke("zipkit:openRecordsWindow"),
  readRecordsPage: (query: RecordsQuery): Promise<RecordsPage> => ipcRenderer.invoke("zipkit:readRecordsPage", query),
  readRecordDetail: (kind: RecordKind, id: number): Promise<RecordDetail | null> =>
    ipcRenderer.invoke("zipkit:readRecordDetail", kind, id),
  readRecordSources: (): Promise<RecordSources> => ipcRenderer.invoke("zipkit:readRecordSources"),
  getRecordsListWidth: (): Promise<number> => ipcRenderer.invoke("zipkit:getRecordsListWidth"),
  saveRecordsListWidth: (width: number): Promise<number> => ipcRenderer.invoke("zipkit:saveRecordsListWidth", width),
  onRecordsChanged: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on(RECORDS_CHANGED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(RECORDS_CHANGED_CHANNEL, handler);
  },
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke("zipkit:appInfo"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("zipkit:openExternal", url),
  reportError: (context: string, error: GuiReportedError): void => {
    ipcRenderer.send("zipkit:reportError", context, error);
  },
} satisfies ZipKitGuiApi;

contextBridge.exposeInMainWorld("zipkit", api);
