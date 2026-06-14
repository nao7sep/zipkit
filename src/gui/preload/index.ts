/**
 * The preload bridge: exposes the typed `window.zipkit` surface to the renderer.
 * Each method is a one-line `ipcRenderer.invoke` to the matching main-process
 * channel. The object is held to the shared `ZipKitGuiApi` interface via
 * `satisfies`, so the bridge and its declared type cannot drift.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { ArchiveSpec, PlanResult, ZipKitGuiApi } from "../shared/api.js";

const api = {
  chooseInputs: (): Promise<string[]> => ipcRenderer.invoke("zipkit:chooseInputs"),
  plan: (spec: ArchiveSpec): Promise<PlanResult> => ipcRenderer.invoke("zipkit:plan", spec),
} satisfies ZipKitGuiApi;

contextBridge.exposeInMainWorld("zipkit", api);
