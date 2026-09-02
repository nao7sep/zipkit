import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {} }));
vi.mock("../../../src/sdk/index.js", () => ({
  ZipKit: class {},
  ZipKitError: class extends Error {},
}));
vi.mock("../../../src/gui/main/log.js", () => ({ createAppLog: () => ({}) }));

import {
  clearMainWindow,
  ensureMainWindow,
  getMainWindow,
  setMainWindow,
  toGuiError,
} from "../../../src/gui/main/runtime.js";

function fakeWindow() {
  return {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: { isDestroyed: () => false, send: vi.fn() },
  };
}

describe("main-window ownership", () => {
  beforeEach(() => setMainWindow(null));

  it("creates at most one live owner", () => {
    const first = fakeWindow();
    const second = fakeWindow();
    const createFirst = vi.fn(() => first as never);
    const createSecond = vi.fn(() => second as never);

    expect(ensureMainWindow(createFirst)).toMatchObject({ window: first, created: true });
    expect(ensureMainWindow(createSecond)).toMatchObject({ window: first, created: false });
    expect(createFirst).toHaveBeenCalledOnce();
    expect(createSecond).not.toHaveBeenCalled();
  });

  it("a stale closed callback cannot clear a replacement owner", () => {
    const first = fakeWindow();
    const replacement = fakeWindow();
    setMainWindow(first as never);
    setMainWindow(replacement as never);

    clearMainWindow(first as never);

    expect(getMainWindow()).toBe(replacement);
  });
});

describe("GUI error presentation", () => {
  it("keeps arbitrary diagnostic text out of the renderer result", () => {
    const result = toGuiError(
      Object.assign(
        new TypeError("EACCES /private/tmp/HOSTILE-SENTINEL Error invoking remote method"),
        { code: "EACCES" },
      ),
    );

    expect(result).toEqual({
      type: "unknown",
      code: "unknown",
      presentation: "Verification could not be completed. Check that the archive is still available, then try again.",
    });
    expect(result.presentation).not.toContain("HOSTILE-SENTINEL");
  });
});
