import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  saveLayout: vi.fn(),
  saveRecordsListWidth: vi.fn(),
  loadLayout: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  records: vi.fn(),
  openRecordsWindow: vi.fn(),
  loadSettings: vi.fn(),
  showAppMessageDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getName: vi.fn(() => "ZipKit"), getVersion: vi.fn(() => "0.1.0") },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
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
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.logWarn,
    error: mocks.logError,
    session: "2026-06-15T01:00:00.000Z",
    records: mocks.records,
  },
  startProgressRun: vi.fn(() => vi.fn()),
  toGuiError: vi.fn(),
  zip: {},
}));
vi.mock("../../../src/gui/main/settings.js", () => ({
  loadSettings: mocks.loadSettings,
  saveSettings: vi.fn(),
}));
vi.mock("../../../src/gui/main/startup-dialog.js", () => ({ showAppMessageDialog: mocks.showAppMessageDialog }));
vi.mock("../../../src/gui/main/i18n.js", async (importActual) => {
  const { createTranslator } = await import("../../../src/gui/shared/i18n/translate.js");
  return {
    ...(await importActual<typeof import("../../../src/gui/main/i18n.js")>()),
    mainTranslator: () => createTranslator("en"),
  };
});
vi.mock("../../../src/gui/main/layout.js", () => ({
  loadLayout: mocks.loadLayout,
  saveLayout: mocks.saveLayout,
  recordsListWidth: () => 450,
  saveRecordsListWidth: mocks.saveRecordsListWidth,
}));
vi.mock("../../../src/gui/main/records-window.js", () => ({ openRecordsWindow: mocks.openRecordsWindow }));
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

describe("settings IPC", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.loadSettings.mockReset();
    mocks.showAppMessageDialog.mockReset().mockResolvedValue(undefined);
    registerIpc();
  });

  it("reports a settings file quarantined mid-session by its preserved path", async () => {
    const value = { defaults: {}, uiFontFamily: "", theme: "system", language: "system" };
    mocks.loadSettings.mockResolvedValue({ value, quarantinedTo: "/data/config-20261006-000000-000-utc.invalid", missing: false });

    await expect(mocks.handlers.get("zipkit:getSettings")!({ sender: {} })).resolves.toBe(value);

    expect(mocks.showAppMessageDialog).toHaveBeenCalledOnce();
    expect(mocks.showAppMessageDialog.mock.calls[0]![0]).toMatchObject({
      title: "Settings were reset",
      message: expect.stringContaining("preserved as /data/config-20261006-000000-000-utc.invalid"),
      button: "ok",
    });
  });

  it("reports nothing when the settings loaded as they were", async () => {
    mocks.loadSettings.mockResolvedValue({ value: {}, quarantinedTo: null, missing: false });
    await mocks.handlers.get("zipkit:getSettings")!({ sender: {} });
    expect(mocks.showAppMessageDialog).not.toHaveBeenCalled();
  });
});

describe("Records window IPC", () => {
  const ALL = { session: null, kind: null, level: null, search: "", after: null };
  const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args);

  beforeEach(() => {
    mocks.handlers.clear();
    for (const mock of [mocks.records, mocks.logWarn, mocks.logError, mocks.openRecordsWindow, mocks.saveRecordsListWidth, mocks.loadLayout]) {
      mock.mockReset();
    }
    registerIpc();
  });

  it("reads a checked query one page at a time", async () => {
    const page = { records: [], more: false };
    mocks.records.mockResolvedValue(page);
    await expect(invoke("zipkit:readRecordsPage", { ...ALL, level: "attention" })).resolves.toBe(page);
    expect(mocks.records).toHaveBeenCalledWith({ op: "page", query: { ...ALL, level: "attention" }, pageSize: 100 });
  });

  it("refuses a malformed query or record without reading, and records why", async () => {
    await expect(invoke("zipkit:readRecordsPage", { ...ALL, kind: "provider-call" })).rejects.toThrow(/kind/);
    await expect(invoke("zipkit:readRecordDetail", "log", 1.5)).rejects.toThrow(/id/);
    await expect(invoke("zipkit:readRecordDetail", "card", 1)).rejects.toThrow(/kind/);
    expect(mocks.records).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledTimes(3);
  });

  it("records a failed read whole and rejects so the window can say so", async () => {
    const failure = new Error("SQLITE_BUSY");
    mocks.records.mockRejectedValue(failure);
    await expect(invoke("zipkit:readRecordDetail", "job-event", 4)).rejects.toBe(failure);
    expect(mocks.records).toHaveBeenCalledWith({ op: "detail", kind: "job-event", id: 4 });
    expect(mocks.logWarn).toHaveBeenCalledWith("records read failed", expect.objectContaining({ error: expect.objectContaining({ message: "SQLITE_BUSY" }) }));
  });

  it("offers the launches the records hold, naming this one", async () => {
    mocks.records.mockResolvedValue(["2026-06-15T01:00:00.000Z", "2026-06-14T05:25:48.123Z"]);
    await expect(invoke("zipkit:readRecordSources")).resolves.toEqual({
      currentSession: "2026-06-15T01:00:00.000Z",
      sessions: ["2026-06-15T01:00:00.000Z", "2026-06-14T05:25:48.123Z"],
    });
    expect(mocks.records).toHaveBeenCalledWith({ op: "sessions" });
  });

  it("reads and saves the list width, refusing one that is not a number", async () => {
    expect(await invoke("zipkit:getRecordsListWidth")).toBe(450);
    mocks.saveRecordsListWidth.mockResolvedValue(640);
    await expect(invoke("zipkit:saveRecordsListWidth", 9000)).resolves.toBe(640);
    await expect(invoke("zipkit:saveRecordsListWidth", Number.NaN)).rejects.toThrow(/finite/);
    expect(mocks.saveRecordsListWidth).toHaveBeenCalledTimes(1);
  });

  it("keeps the main window's layout to its own panes", async () => {
    mocks.loadLayout.mockResolvedValue({ value: { jobsWidth: 300, progressWidth: 360, recordsListWidth: 500 }, quarantinedTo: null });
    await expect(invoke("zipkit:getLayout")).resolves.toEqual({ jobsWidth: 300, progressWidth: 360 });
  });

  it("opens the Records window, recording a failure before it rejects", async () => {
    mocks.openRecordsWindow.mockResolvedValueOnce(undefined);
    await expect(invoke("zipkit:openRecordsWindow")).resolves.toBeUndefined();
    const failure = new Error("no page");
    mocks.openRecordsWindow.mockRejectedValueOnce(failure);
    await expect(invoke("zipkit:openRecordsWindow")).rejects.toBe(failure);
    expect(mocks.logError).toHaveBeenCalledWith("records window failed to open", expect.anything());
  });
});
