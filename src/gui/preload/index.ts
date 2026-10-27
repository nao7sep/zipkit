/**
 * The preload bridge: exposes the typed `window.zipkit` surface to the renderer.
 * Methods invoke or subscribe to the matching main-process channel; job edits
 * retain their submission receipts so native Quit can capture them. Held to the shared `ZipKitGuiApi` interface via
 * `satisfies`, so the bridge and its declared type cannot drift.
 */

import { contextBridge, ipcRenderer, webUtils } from "electron";
import { createJobEditSubmissions } from "./job-edits.js";
import type { GuiOptions, GuiSettings } from "../shared/spec.js";
import type { PaneLayout } from "../shared/layout.js";
import type { RecordDetail, RecordKind, RecordSources, RecordsPage, RecordsQuery } from "../shared/records.js";
import { LANGUAGE_CHANGED_CHANNEL, OPEN_ABOUT_CHANNEL, RECORDS_CHANGED_CHANNEL, WINDOW_ACTIVITY_CHANNEL, type AppInfo, type LanguageEnvironment, type SystemChoices, type JobCounts, type JobEvent, type GuiReportedError, type Job, type JobIntent, type PlanReport, type VerifyResult, type ZipKitGuiApi } from "../shared/api.js";

const jobEdits = createJobEditSubmissions((id, patch) => ipcRenderer.invoke("zipkit:updateJob", id, patch));
// Preload has a browser document but keeps Node types out of renderer compilation.
const editorDocument = (globalThis as unknown as { document?: { body?: { inert: boolean } } }).document;
let previousInert: boolean | undefined;
ipcRenderer.on("zipkit:captureJobEdits", (_event, id: number) => {
  if (!Number.isSafeInteger(id) || id <= 0) return;
  if (editorDocument?.body) {
    previousInert ??= editorDocument.body.inert;
    editorDocument.body.inert = true;
  }
  void jobEdits.capture().then(
    () => ipcRenderer.send(`zipkit:jobEditsCaptured:${id}`, true),
    () => ipcRenderer.send(`zipkit:jobEditsCaptured:${id}`, false),
  );
});
ipcRenderer.on("zipkit:resumeJobEdits", () => {
  jobEdits.resume();
  if (editorDocument?.body && previousInert !== undefined) editorDocument.body.inert = previousInert;
  previousInert = undefined;
});

const api = {
  chooseInputs: (existingInputs?: string[]): Promise<string[]> => ipcRenderer.invoke("zipkit:chooseInputs", existingInputs),
  chooseOutputDir: (currentDir?: string, inputs?: string[], fileName?: string): Promise<string> => ipcRenderer.invoke("zipkit:chooseOutputDir", currentDir, inputs, fileName),
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
  getSystemChoices: (): Promise<SystemChoices> => ipcRenderer.invoke("zipkit:getSystemChoices"),
  onOpenAbout: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on(OPEN_ABOUT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(OPEN_ABOUT_CHANNEL, handler);
  },
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
  reportSettingsDraft: (dirty: boolean): void => ipcRenderer.send("zipkit:settingsDraft", dirty),
  getSettings: (): Promise<GuiSettings> => ipcRenderer.invoke("zipkit:getSettings"),
  setSettings: (settings: GuiSettings): Promise<GuiSettings> =>
    ipcRenderer.invoke("zipkit:setSettings", settings),
  getLayout: (): Promise<PaneLayout> => ipcRenderer.invoke("zipkit:getLayout"),
  setLayout: (layout: PaneLayout): Promise<void> => ipcRenderer.invoke("zipkit:setLayout", layout),
  addJob: (inputs: string[], options: GuiOptions): Promise<string> =>
    ipcRenderer.invoke("zipkit:addJob", inputs, options),
  updateJob: (
    id: string,
    patch: { options?: GuiOptions; intent?: JobIntent },
  ): Promise<void> => jobEdits.submit(id, patch),
  addJobInputs: (id: string, paths: string[]) => ipcRenderer.invoke("zipkit:addJobInputs", id, paths),
  removeJobInput: (id: string, path: string): Promise<void> => ipcRenderer.invoke("zipkit:removeJobInput", id, path),
  removeJob: (id: string): Promise<void> => ipcRenderer.invoke("zipkit:removeJob", id),
  runJob: (id, scope): Promise<void> => ipcRenderer.invoke("zipkit:runJob", id, scope),
  removeArchive: (id: string): Promise<void> => ipcRenderer.invoke("zipkit:removeArchive", id),
  trashOriginals: (id: string): Promise<void> => ipcRenderer.invoke("zipkit:trashOriginals", id),
  deleteOriginals: (id: string): Promise<void> => ipcRenderer.invoke("zipkit:deleteOriginals", id),
  cancelJob: (id: string): Promise<void> => ipcRenderer.invoke("zipkit:cancelJob", id),
  getPlan: (id: string): Promise<PlanReport | null> => ipcRenderer.invoke("zipkit:getPlan", id),
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
  verify: (jobId: string): Promise<VerifyResult | null> => ipcRenderer.invoke("zipkit:verify", jobId),
  refreshJob: (jobId: string): Promise<void> => ipcRenderer.invoke("zipkit:refreshJob", jobId),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke("zipkit:reveal", path),
  getJobEvents: (jobId: string): Promise<JobEvent[]> => ipcRenderer.invoke("zipkit:getJobEvents", jobId),
  onEvents: (callback: (events: JobEvent[]) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, events: JobEvent[]): void => callback(events);
    ipcRenderer.on("zipkit:events", handler);
    return () => {
      ipcRenderer.removeListener("zipkit:events", handler);
    };
  },
  onProgress: (callback: (counts: JobCounts[]) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, counts: JobCounts[]): void => callback(counts);
    ipcRenderer.on("zipkit:counts", handler);
    return () => {
      ipcRenderer.removeListener("zipkit:counts", handler);
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
