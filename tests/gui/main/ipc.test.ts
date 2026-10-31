import { beforeEach, describe, expect, it, vi } from "vitest";
import { dialog } from "electron";
import path from "node:path";
import { homedir } from "node:os";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  saveLayout: vi.fn(),
  saveRecordsListWidth: vi.fn(),
  paneLayout: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  records: vi.fn(),
  openRecordsWindow: vi.fn(),
  currentSettings: vi.fn(),
  saveSettings: vi.fn(),
  applyTheme: vi.fn(),
  applyLanguage: vi.fn(),
  showAppMessageDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getName: vi.fn(() => "ZipKit"), getVersion: vi.fn(() => "1.0.0") },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: vi.fn(() => null) },
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
}));
vi.mock("../../../src/gui/main/settings.js", () => ({
  checkedSettings: (settings: unknown) => settings,
  currentSettings: mocks.currentSettings,
  saveSettings: mocks.saveSettings,
}));
vi.mock("../../../src/gui/main/theme.js", () => ({ applyThemePreference: mocks.applyTheme }));
vi.mock("../../../src/gui/main/startup-dialog.js", () => ({ showAppMessageDialog: mocks.showAppMessageDialog }));
vi.mock("../../../src/gui/main/i18n.js", async (importActual) => {
  const { createTranslator } = await import("../../../src/gui/shared/i18n/translate.js");
  return {
    ...(await importActual<typeof import("../../../src/gui/main/i18n.js")>()),
    mainTranslator: () => createTranslator("en"),
    applyLanguagePreference: mocks.applyLanguage,
  };
});
vi.mock("../../../src/gui/main/layout.js", () => ({
  paneLayout: mocks.paneLayout,
  saveLayout: mocks.saveLayout,
  recordsListWidth: () => 450,
  saveRecordsListWidth: mocks.saveRecordsListWidth,
}));
vi.mock("../../../src/gui/main/records-window.js", () => ({ openRecordsWindow: mocks.openRecordsWindow }));
vi.mock("../../../src/gui/main/url.js", () => ({ isHttpUrl: vi.fn(() => true) }));

import { DEFAULT_SETTINGS } from "../../../src/gui/shared/spec.js";
import { registerIpc } from "../../../src/gui/main/ipc.js";

describe("pane-layout IPC", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.saveLayout.mockReset();
    mocks.logError.mockReset();
    registerIpc();
  });

  it("logs a failed save and rejects", async () => {
    const failure = new Error("read-only store");
    mocks.saveLayout.mockRejectedValue(failure);
    const handler = mocks.handlers.get("zipkit:setLayout")!;

    await expect(handler({}, { jobsWidth: 300, statusWidth: 360 })).rejects.toBe(failure);
    expect(mocks.logError).toHaveBeenCalledWith(
      "failed to persist layout",
      expect.objectContaining({ error: expect.anything() }),
    );
  });
});

describe("settings IPC", () => {
  it("returns committed settings with a safe warning when applying the interface fails", async () => {
    registerIpc();
    mocks.saveSettings.mockResolvedValue(DEFAULT_SETTINGS);
    mocks.currentSettings.mockReturnValue(DEFAULT_SETTINGS);
    const failure = new Error("hostile EPERM /private/internal sentinel");
    mocks.applyTheme.mockImplementation(() => { throw failure; });
    mocks.applyLanguage.mockRejectedValue(failure);
    mocks.showAppMessageDialog.mockResolvedValue(undefined);
    mocks.logWarn.mockClear();
    await expect(mocks.handlers.get("zipkit:setSettings")!({ sender: {} }, DEFAULT_SETTINGS)).resolves.toEqual(DEFAULT_SETTINGS);
    expect(mocks.applyLanguage).toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("settings saved but interface application was incomplete", expect.objectContaining({ errors: expect.any(Array) }));
    const shown = mocks.showAppMessageDialog.mock.calls.at(-1)![0] as { message: string };
    expect(shown.message).toContain("Settings were saved");
    expect(shown.message).not.toContain("sentinel");
    mocks.applyTheme.mockReset(); mocks.applyLanguage.mockReset(); mocks.saveSettings.mockReset();
  });

  it("a failed settings write rejects without applying or showing a saved warning", async () => {
    registerIpc();
    const failure = new Error("write failed");
    mocks.saveSettings.mockRejectedValue(failure);
    mocks.applyTheme.mockClear(); mocks.applyLanguage.mockClear(); mocks.showAppMessageDialog.mockClear();
    await expect(mocks.handlers.get("zipkit:setSettings")!({ sender: {} }, DEFAULT_SETTINGS)).rejects.toBe(failure);
    expect(mocks.applyTheme).not.toHaveBeenCalled();
    expect(mocks.applyLanguage).not.toHaveBeenCalled();
    expect(mocks.showAppMessageDialog).not.toHaveBeenCalled();
    mocks.saveSettings.mockReset();
  });

  beforeEach(() => {
    mocks.handlers.clear();
    mocks.currentSettings.mockReset();
    mocks.showAppMessageDialog.mockReset().mockResolvedValue(undefined);
    registerIpc();
  });

  it("answers from main's copy of the settings, without reading the file or showing anything", async () => {
    const value = { newJobParameters: {}, uiFontFamily: "", theme: "system", language: "system" };
    mocks.currentSettings.mockReturnValue(value);

    expect(mocks.handlers.get("zipkit:getSettings")!({ sender: {} })).toBe(value);

    expect(mocks.currentSettings).toHaveBeenCalledOnce();
    expect(mocks.showAppMessageDialog).not.toHaveBeenCalled();
  });
});

describe("Records window IPC", () => {
  const ALL = { session: null, kind: null, level: null, search: "", after: null };
  const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args);

  beforeEach(() => {
    mocks.handlers.clear();
    for (const mock of [mocks.records, mocks.logWarn, mocks.logError, mocks.openRecordsWindow, mocks.saveRecordsListWidth, mocks.paneLayout]) {
      mock.mockReset();
    }
    registerIpc();
  });

  it("reads a checked query one page at a time", async () => {
    const page = { records: [], more: false };
    mocks.records.mockResolvedValue(page);
    await expect(invoke("zipkit:readRecordsPage", { ...ALL, level: "warningsAndErrors" })).resolves.toBe(page);
    expect(mocks.records).toHaveBeenCalledWith({ op: "page", query: { ...ALL, level: "warningsAndErrors" }, pageSize: 100 });
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

  it("answers the main window's layout from main's copy", async () => {
    mocks.paneLayout.mockReturnValue({ jobsWidth: 300, statusWidth: 360 });
    expect(invoke("zipkit:getLayout")).toEqual({ jobsWidth: 300, statusWidth: 360 });
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


describe("contextual native pickers", () => {
  const source = path.join(path.sep, "source");
  const first = path.join(source, "first.txt");
  const second = path.join(source, "second");

  beforeEach(() => {
    registerIpc();
    vi.mocked(dialog.showOpenDialog).mockReset().mockResolvedValue({ canceled: true, filePaths: [] });
  });

  async function output(currentDir = "", inputs: string[] = [], fileName = "") {
    return mocks.handlers.get("zipkit:chooseOutputDir")!({}, currentDir, inputs, fileName);
  }

  it("uses current authored output text before source context and expands its leading home", async () => {
    await output("~/delivery", [first]);
    expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: path.join(homedir(), "delivery") }));
    const literal = path.join(source, "$NOT_EXPANDED", "%LITERAL%", " spaced ");
    await output(literal, [first]);
    expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: literal }));
  });

  it("infers blank output beside unambiguous sources, and follows the named mixed-input rule", async () => {
    await output("", [first, second]);
    expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: source }));
    const other = path.join(path.sep, "other", "third.txt");
    await output("", [first, other]);
    expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: undefined }));
    await output("", [first, other], "bundle");
    expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: source }));
  });

  it("leaves invalid relative output and absent context to the platform", async () => {
    await output("relative/path", [first]);
    expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: undefined }));
    await output();
    expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: undefined }));
  });

  it("uses only a shared parent for adding inputs and keeps a new job generic", async () => {
    const choose = mocks.handlers.get("zipkit:chooseInputs")!;
    await choose({}, [first, second]);
    expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: source }));
    await choose({}, [first, path.join(path.sep, "other", "third.txt")]);
    expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: undefined }));
    await choose({});
    expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: undefined }));
  });

  it("returns cancellation without a selection and keeps picker failures rejectable", async () => {
    expect(await output("", [first])).toBe("");
    expect(await mocks.handlers.get("zipkit:chooseInputs")!({}, [first])).toEqual([]);
    const failure = new Error("picker unavailable");
    vi.mocked(dialog.showOpenDialog).mockRejectedValue(failure);
    await expect(output("", [first])).rejects.toBe(failure);
    await expect(mocks.handlers.get("zipkit:chooseInputs")!({}, [first])).rejects.toBe(failure);
  });
});
