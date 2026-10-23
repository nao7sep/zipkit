import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZipKitGuiApi } from "../../../src/gui/shared/api.js";
import { WINDOW_ACTIVITY_CHANNEL } from "../../../src/gui/shared/api.js";
import { DEFAULT_SETTINGS } from "../../../src/gui/shared/spec.js";

const electron = vi.hoisted(() => {
  let exposed: ZipKitGuiApi | undefined;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    contextBridge: {
      exposeInMainWorld: vi.fn((_name: string, api: ZipKitGuiApi) => { exposed = api; }),
    },
    ipcRenderer: {
      invoke: vi.fn(),
      send: vi.fn(),
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        listeners.set(channel, listener);
      }),
      removeListener: vi.fn(),
    },
    webUtils: { getPathForFile: vi.fn() },
    api: () => exposed,
    listeners,
  };
});

vi.mock("electron", () => ({
  contextBridge: electron.contextBridge,
  ipcRenderer: electron.ipcRenderer,
  webUtils: electron.webUtils,
}));

await import("../../../src/gui/preload/index.js");

beforeEach(() => {
  electron.ipcRenderer.on.mockClear();
  electron.ipcRenderer.removeListener.mockClear();
});

describe("preload window activity bridge", () => {
  it("forwards only boolean activity and removes the exact listener", () => {
    const callback = vi.fn();
    const cleanup = electron.api()?.onWindowActivityChanged(callback);
    const handler = electron.listeners.get(WINDOW_ACTIVITY_CHANNEL);

    handler?.({}, false);
    handler?.({}, "not native state");
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(false);

    cleanup?.();
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(WINDOW_ACTIVITY_CHANNEL, handler);
  });
});

it("reads Settings ownership and forwards submission updates with exact listener cleanup", async () => {
  electron.ipcRenderer.invoke.mockResolvedValueOnce(null);
  await expect(electron.api()!.getSettingsSubmission()).resolves.toBeNull();
  expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith("zipkit:getSettingsSubmission");
  const callback = vi.fn();
  const unsubscribe = electron.api()!.onSettingsSubmissionChanged(callback);
  const listener = electron.listeners.get("zipkit:settingsSubmissionChanged")!;
  const submission = { draft: DEFAULT_SETTINGS, status: "saving", startedAt: 123 };
  listener({}, submission);
  expect(callback).toHaveBeenCalledWith(submission);
  unsubscribe();
  expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith("zipkit:settingsSubmissionChanged", listener);
});
