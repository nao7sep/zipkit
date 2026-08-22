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
