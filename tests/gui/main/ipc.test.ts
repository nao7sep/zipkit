import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  saveLayout: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getName: vi.fn(() => "ZipKit"), getVersion: vi.fn(() => "0.1.0") },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
  shell: { showItemInFolder: vi.fn(), openExternal: vi.fn() },
}));
vi.mock("../../../src/gui/main/runtime.js", () => ({
  getMainWindow: vi.fn(() => null),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.logError },
  sendEvent: vi.fn(),
  toGuiError: vi.fn(),
  zip: {},
}));
vi.mock("../../../src/gui/main/settings.js", () => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
}));
vi.mock("../../../src/gui/main/layout.js", () => ({
  loadLayout: vi.fn(),
  saveLayout: mocks.saveLayout,
}));
vi.mock("../../../src/gui/main/url.js", () => ({ isHttpUrl: vi.fn(() => true) }));

import { registerIpc } from "../../../src/gui/main/ipc.js";

describe("pane-layout IPC", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.saveLayout.mockReset();
    mocks.logError.mockReset();
    registerIpc();
  });

  it("logs a failed save and rejects so the renderer can own the persistent result", async () => {
    const failure = new Error("read-only store");
    mocks.saveLayout.mockRejectedValue(failure);
    const handler = mocks.handlers.get("zipkit:setLayout")!;

    await expect(handler({}, { jobsWidth: 300, progressWidth: 360 })).rejects.toBe(failure);
    expect(mocks.logError).toHaveBeenCalledWith(
      "failed to persist layout",
      expect.objectContaining({ error: expect.anything() }),
    );
  });
});
