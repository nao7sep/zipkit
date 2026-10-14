/**
 * The OS lifecycle events delivered into the handlers the real bootstrap
 * registers, with the quit sequence in `quit.ts` real and everything it drives
 * stubbed. Electron's own delivery is native: macOS posts
 * NSWorkspaceWillPowerOffNotification, which Electron emits as powerMonitor
 * `shutdown`, before the quit that follows; Windows sends WM_ENDSESSION, which
 * Electron emits as the window's `session-end`, and no `before-quit` follows.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const fn = vi.fn;
  return {
    app: undefined as unknown as EventEmitter & Record<string, ReturnType<typeof fn>>,
    powerMonitor: undefined as unknown as EventEmitter,
    windows: [] as Array<EventEmitter & Record<string, unknown>>,
    hasRunningJob: fn(() => false),
    confirmQuitDuringWrite: fn(async () => true),
    askQueueNotSaved: fn(async () => "quit" as const),
    askSettingsNotSaved: fn(async () => "quit" as const),
    beginQueueQuit: fn(),
    cancelRunningJobAndWait: fn(async () => {}),
    flushQueue: fn(async () => {}),
    saveQueueBeforeSessionEnd: fn((_bound: number) => {}),
    settleSettingsSave: fn(async () => {}),
    saveSettingsBeforeSessionEnd: fn((_bound: number) => {}),
    captureJobEdits: fn(async () => {}),
    layoutWritesSettled: fn(async () => {}),
    closeBackupStore: fn(async () => {}),
    logClose: fn(async () => {}),
    forceExitProcess: fn(),
    showAppMessageDialog: fn(async () => {}),
  };
});

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class BrowserWindow extends EventEmitter {
    webContents = { send: vi.fn() };
    constructor() { super(); m.windows.push(this as never); }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    show() {}
    focus() {}
    restore() {}
    close() {}
    static getAllWindows() { return m.windows; }
  }
  return {
    get app() { return m.app; },
    get powerMonitor() { return m.powerMonitor; },
    BrowserWindow,
    nativeTheme: { shouldUseDarkColors: false },
  };
});

vi.mock("../../../src/gui/main/theme.js", () => ({ applyThemePreference: vi.fn(), followOsThemeChanges: vi.fn() }));
vi.mock("../../../src/gui/main/recoveryDialogs.js", () => ({ buildRecoveryDialogs: () => [] }));
vi.mock("../../../src/gui/main/renderer-page.js", () => ({ loadRendererPage: async () => {} }));
vi.mock("../../../src/gui/main/records-window.js", () => ({ notifyRecordsChanged: vi.fn() }));
vi.mock("../../../src/gui/main/ipc.js", () => ({ registerIpc: vi.fn() }));
vi.mock("../../../src/gui/main/queue.js", () => ({
  beginQueueQuit: m.beginQueueQuit, cancelRunningJobAndWait: m.cancelRunningJobAndWait, flushQueue: m.flushQueue,
  hasRunningJob: m.hasRunningJob, registerQueueIpc: vi.fn(), restoreQueue: vi.fn(),
  saveQueueBeforeSessionEnd: m.saveQueueBeforeSessionEnd, resumeQueueAfterCancelledQuit: vi.fn(),
}));
vi.mock("../../../src/gui/main/settings-save.js", () => ({
  discardSettingsSubmission: vi.fn(), settingsSavePending: () => false,
  settleSettingsSave: m.settleSettingsSave, saveSettingsBeforeSessionEnd: m.saveSettingsBeforeSessionEnd,
}));
vi.mock("../../../src/gui/main/settings.js", () => ({
  loadSettings: async () => ({ value: { theme: "system", language: "en" }, quarantinedTo: undefined }),
  settingsFile: () => "/unused/config.json",
}));
vi.mock("../../../src/gui/main/i18n.js", () => ({
  applyLanguagePreference: async () => {}, applyTimeZonePreference: vi.fn(), mainTranslator: () => ({ t: (key: string) => key }),
  onLanguageChanged: vi.fn(), readConfigText: async () => null, readSavedPreference: () => undefined,
  settleLanguage: async () => {},
}));
vi.mock("../../../src/gui/main/menu.js", () => ({ installAppMenu: vi.fn() }));
vi.mock("../../../src/gui/main/runtime.js", () => {
  let main: unknown = null;
  return {
    clearMainWindow: () => { main = null; },
    ensureMainWindow: (create: () => unknown) => { main = create(); return { window: main, created: true }; },
    getMainWindow: () => main,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), close: m.logClose, onStored: vi.fn(), database: "unused", session: "unused" },
    sendQueueSaved: vi.fn(),
  };
});
vi.mock("../../../src/gui/main/layout.js", () => ({ layoutWritesSettled: m.layoutWritesSettled, loadLayout: async () => {} }));
vi.mock("../../../src/gui/main/persist.js", () => ({ loadQueue: async () => ({ value: { jobs: [] }, quarantinedTo: undefined }) }));
vi.mock("../../../src/gui/main/startup-dialog.js", () => ({ notifyStartupFailure: vi.fn(async () => {}), showAppMessageDialog: m.showAppMessageDialog }));
vi.mock("../../../src/gui/main/quit-confirm-dialog.js", () => ({
  askQueueNotSaved: m.askQueueNotSaved, askSettingsNotSaved: m.askSettingsNotSaved, confirmQuitDuringWrite: m.confirmQuitDuringWrite,
}));
vi.mock("../../../src/gui/main/windowActivity.js", () => ({ configureWindowActivity: vi.fn() }));
vi.mock("../../../src/gui/main/backupStore.js", () => ({ closeBackupStore: m.closeBackupStore }));
vi.mock("../../../src/gui/main/job-edit-capture.js", () => ({ captureJobEdits: m.captureJobEdits, resumeJobEdits: vi.fn() }));
vi.mock("../../../src/gui/main/window-minimum.js", () => ({ configureWindowMinimum: vi.fn() }));
vi.mock("../../../src/gui/main/force-exit.js", () => ({ forceExitProcess: m.forceExitProcess }));
vi.mock("../../../src/gui/main/pending-work.js", () => ({ nativeWorkPending: () => false }));
vi.mock("../../../src/gui/main/window-options.js", () => ({ mainWindowOptions: () => ({}) }));
vi.mock("../../../src/gui/main/window-state-recovery.js", () => ({
  createWindowWithUsablePersistedBounds: (_name: string, create: () => unknown) => create(),
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let processListeners: { uncaught: Function[]; rejection: Function[] };

/** Load the real bootstrap fresh and wait until startup has opened the main window. */
async function start(host: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { ...platform, value: host });
  await import("../../../src/gui/main/bootstrap.js");
  await vi.waitFor(() => expect(m.app.listenerCount("activate")).toBe(1));
  return m.windows[0]!;
}

const quitEvent = () => ({ preventDefault: vi.fn() });
const questions = () => [m.confirmQuitDuringWrite, m.askQueueNotSaved, m.askSettingsNotSaved, m.showAppMessageDialog];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  const app = new EventEmitter() as typeof m.app;
  Object.assign(app, { whenReady: vi.fn(() => Promise.resolve()), exit: vi.fn(), quit: vi.fn() });
  m.app = app;
  m.powerMonitor = new EventEmitter();
  m.windows.length = 0;
  m.hasRunningJob.mockReturnValue(false);
  processListeners = { uncaught: process.listeners("uncaughtException"), rejection: process.listeners("unhandledRejection") };
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  for (const [event, before] of [["uncaughtException", processListeners.uncaught], ["unhandledRejection", processListeners.rejection]] as const) {
    for (const listener of process.listeners(event)) if (!before.includes(listener)) process.off(event, listener as never);
  }
});

describe("macOS logout, restart and shutdown", () => {
  it("never delays the OS: the shutdown listener leaves the event alone", async () => {
    await start("darwin");
    const shutdown = quitEvent();
    m.powerMonitor.emit("shutdown", shutdown);
    expect(m.powerMonitor.listenerCount("shutdown")).toBe(1);
    expect(shutdown.preventDefault).not.toHaveBeenCalled();
  });

  it("quits a running job without asking, saves Settings and the queue, and exits", async () => {
    await start("darwin");
    m.hasRunningJob.mockReturnValue(true);
    m.powerMonitor.emit("shutdown", quitEvent());
    const quit = quitEvent();
    m.app.emit("before-quit", quit);
    await vi.waitFor(() => expect(m.app.exit).toHaveBeenCalledWith(0));
    expect(quit.preventDefault).toHaveBeenCalled();
    for (const question of questions()) expect(question).not.toHaveBeenCalled();
    expect(m.captureJobEdits).toHaveBeenCalled();
    expect(m.cancelRunningJobAndWait).toHaveBeenCalled();
    expect(m.settleSettingsSave).toHaveBeenCalled();
    expect(m.flushQueue).toHaveBeenCalled();
    expect(m.logClose).toHaveBeenCalled();
    // Optional backup closing is skipped while the session ends.
    expect(m.closeBackupStore).not.toHaveBeenCalled();
    expect(m.forceExitProcess).not.toHaveBeenCalled();
  });

  it("still exits without asking when the saves fail", async () => {
    await start("darwin");
    m.settleSettingsSave.mockRejectedValueOnce(new Error("disk full"));
    m.flushQueue.mockRejectedValueOnce(new Error("disk full"));
    m.powerMonitor.emit("shutdown", quitEvent());
    m.app.emit("before-quit", quitEvent());
    await vi.waitFor(() => expect(m.app.exit).toHaveBeenCalledWith(0));
    for (const question of questions()) expect(question).not.toHaveBeenCalled();
  });

  it("asks before cancelling a running job when the user quits", async () => {
    await start("darwin");
    m.hasRunningJob.mockReturnValue(true);
    m.confirmQuitDuringWrite.mockResolvedValueOnce(false);
    m.app.emit("before-quit", quitEvent());
    await vi.waitFor(() => expect(m.confirmQuitDuringWrite).toHaveBeenCalledOnce());
    expect(m.app.exit).not.toHaveBeenCalled();
  });
});

describe("Windows logoff, restart and shutdown", () => {
  it("saves submitted Settings and the queue within the session budget and exits before the handler returns", async () => {
    const win = await start("win32");
    m.hasRunningJob.mockReturnValue(true);
    win.emit("session-end");
    expect(m.saveSettingsBeforeSessionEnd).toHaveBeenCalledOnce();
    expect(m.saveQueueBeforeSessionEnd).toHaveBeenCalledOnce();
    for (const save of [m.saveSettingsBeforeSessionEnd, m.saveQueueBeforeSessionEnd]) {
      const bound = save.mock.calls[0]![0];
      expect(bound).toBeGreaterThan(0);
      expect(bound).toBeLessThanOrEqual(2_000);
    }
    expect(m.app.exit).toHaveBeenCalledWith(0);
    for (const question of questions()) expect(question).not.toHaveBeenCalled();
  });

  it("still exits before the handler returns when a save fails", async () => {
    const win = await start("win32");
    m.saveQueueBeforeSessionEnd.mockImplementationOnce(() => { throw new Error("disk full"); });
    win.emit("session-end");
    expect(m.app.exit).toHaveBeenCalledWith(0);
  });

  it("never vetoes the end of the session", async () => {
    const win = await start("win32");
    expect(win.listenerCount("query-session-end")).toBe(0);
  });

  it("turns closing the main window into the app's quit", async () => {
    const win = await start("win32");
    const close = quitEvent();
    win.emit("close", close);
    expect(close.preventDefault).toHaveBeenCalled();
    expect(m.app.quit).toHaveBeenCalledOnce();
  });
});
