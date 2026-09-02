import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exit: vi.fn(),
  notifyStartupFailure: vi.fn().mockResolvedValue(undefined),
  bootstrapLoaded: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    exit: mocks.exit,
    quit: vi.fn(),
  },
}));

vi.mock("../../../src/sdk/storage.js", () => {
  class StorageRootError extends Error {}
  return {
    StorageRootError,
    storageRoot: () => {
      throw new StorageRootError('hostile EACCES /private/tmp/sentinel "$SECRET"');
    },
  };
});

vi.mock("../../../src/gui/main/startup-dialog.js", () => ({
  notifyStartupFailure: mocks.notifyStartupFailure,
}));

vi.mock("../../../src/gui/main/bootstrap.js", () => {
  mocks.bootstrapLoaded();
  return {};
});

describe("startup storage failure", () => {
  afterEach(() => vi.clearAllMocks());

  it("uses only the authored startup dialog and does not load the app bootstrap", async () => {
    await expect(import("../../../src/gui/main/index.js")).resolves.toBeDefined();
    await vi.waitFor(() => expect(mocks.notifyStartupFailure).toHaveBeenCalledOnce());

    expect(mocks.notifyStartupFailure).toHaveBeenCalledWith(
      "ZipKit could not open its data folder. Restore access to the configured folder, then start ZipKit again.",
    );
    expect(mocks.notifyStartupFailure.mock.calls.flat().join(" ")).not.toMatch(
      /EACCES|private\/tmp|sentinel|SECRET/,
    );
    expect(mocks.bootstrapLoaded).not.toHaveBeenCalled();
    expect(mocks.exit).toHaveBeenCalledWith(1);
  });
});
