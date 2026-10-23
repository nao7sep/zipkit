import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  exit: vi.fn(), quit: vi.fn(), notifyStartupFailure: vi.fn(async () => {}),
  bootstrapLoaded: vi.fn(), installAppMenu: vi.fn(), prepareStorage: vi.fn(async (_root: string) => {}),
  storageRoot: vi.fn(() => "/disposable/zipkit"), setPath: vi.fn(), setAppLogsPath: vi.fn(),
  lock: vi.fn(() => true),
}));
vi.mock("electron", () => ({ app: {
  requestSingleInstanceLock: mocks.lock, whenReady: () => Promise.resolve(),
  exit: mocks.exit, quit: mocks.quit, setPath: mocks.setPath, setAppLogsPath: mocks.setAppLogsPath,
} }));
vi.mock("../../../src/gui/main/storage.js", async (importActual) => ({ ...await importActual<typeof import("../../../src/gui/main/storage.js")>(), storageRoot: mocks.storageRoot }));
vi.mock("../../../src/gui/main/storage-startup.js", () => ({ prepareStorage: mocks.prepareStorage }));
vi.mock("../../../src/gui/main/startup-dialog.js", () => ({ notifyStartupFailure: mocks.notifyStartupFailure }));
vi.mock("../../../src/gui/main/i18n.js", () => ({ settledTranslator: async () => ({ language: "en" }) }));
vi.mock("../../../src/gui/main/menu.js", () => ({ installAppMenu: mocks.installAppMenu }));
vi.mock("../../../src/gui/main/bootstrap.js", () => { mocks.bootstrapLoaded(); return {}; });
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.lock.mockReturnValue(true); });
describe("startup entry", () => {
  it("awaits storage preparation and configures all paths before the instance lock", async () => {
    let release!: () => void;
    mocks.prepareStorage.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const loading = import("../../../src/gui/main/index.js");
    await vi.waitFor(() => expect(mocks.prepareStorage).toHaveBeenCalledOnce());
    expect(mocks.setPath).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
    release();
    await loading;
    expect(mocks.setPath.mock.calls).toEqual([
      ["userData", path.join("/disposable/zipkit", "electron")],
      ["sessionData", path.join("/disposable/zipkit", "electron/session")],
      ["crashDumps", path.join("/disposable/zipkit", "electron/crashes")],
    ]);
    expect(mocks.setAppLogsPath).toHaveBeenCalledWith(path.join("/disposable/zipkit", "electron/logs"));
    expect(mocks.setAppLogsPath.mock.invocationCallOrder[0]).toBeLessThan(mocks.lock.mock.invocationCallOrder[0]!);
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.bootstrapLoaded.mock.invocationCallOrder[0]!);
  });
  it("a second instance configures paths then quits without bootstrap", async () => {
    mocks.lock.mockReturnValueOnce(false);
    await import("../../../src/gui/main/index.js");
    expect(mocks.setPath).toHaveBeenCalledTimes(3);
    expect(mocks.quit).toHaveBeenCalledOnce();
    expect(mocks.bootstrapLoaded).not.toHaveBeenCalled();
  });
  it.each(["resolution", "preparation"])("a %s failure presents authored guidance without acquiring the lock", async (stage) => {
    const error = new Error('hostile EACCES /private/tmp/sentinel "$SECRET"');
    if (stage === "resolution") mocks.storageRoot.mockImplementationOnce(() => { throw error; });
    else mocks.prepareStorage.mockRejectedValueOnce(error);
    await expect(import("../../../src/gui/main/index.js")).resolves.toBeDefined();
    await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(1));
    expect(mocks.notifyStartupFailure).toHaveBeenCalledExactlyOnceWith("startup.dataFolder");
    expect(mocks.installAppMenu).toHaveBeenCalledOnce();
    expect(mocks.setPath).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.bootstrapLoaded).not.toHaveBeenCalled();
  });
});
