import { describe, expect, it, vi } from "vitest";
import { configureWindowActivity } from "../../../src/gui/main/windowActivity.js";
import { WINDOW_ACTIVITY_CHANNEL } from "../../../src/gui/shared/api.js";

describe("native window activity transport", () => {
  it("uses macOS application activation even when BrowserWindow remains focused", () => {
    const applicationListeners = new Map<string, () => void>();
    const windowListeners = new Map<string, () => void>();
    const contentListeners = new Map<string, () => void>();
    const send = vi.fn();
    let focused = false;
    let destroyed = false;
    const application = {
      on: vi.fn((event: string, listener: () => void) => {
        applicationListeners.set(event, listener);
      }),
      removeListener: vi.fn(),
    };
    const window = {
      on: vi.fn((event: string, listener: () => void) => {
        windowListeners.set(event, listener);
        return window;
      }),
      once: vi.fn((event: string, listener: () => void) => {
        windowListeners.set(event, listener);
        return window;
      }),
      isFocused: () => focused,
      webContents: {
        on: vi.fn((event: string, listener: () => void) => {
          contentListeners.set(event, listener);
        }),
        isDestroyed: () => destroyed,
        send,
      },
    };

    configureWindowActivity(
      application as unknown as Electron.App,
      window as unknown as Electron.BrowserWindow,
    );
    contentListeners.get("did-finish-load")?.();
    expect(send).toHaveBeenLastCalledWith(WINDOW_ACTIVITY_CHANNEL, false);
    focused = true;
    windowListeners.get("focus")?.();
    expect(send).toHaveBeenLastCalledWith(WINDOW_ACTIVITY_CHANNEL, true);

    // This is the packaged macOS failure mode: the app resigns active status,
    // while BrowserWindow.isFocused() and the renderer's DOM focus stay true.
    applicationListeners.get("did-resign-active")?.();
    expect(send).toHaveBeenLastCalledWith(WINDOW_ACTIVITY_CHANNEL, false);
    expect(focused).toBe(true);
    applicationListeners.get("did-become-active")?.();
    expect(send).toHaveBeenLastCalledWith(WINDOW_ACTIVITY_CHANNEL, true);

    windowListeners.get("blur")?.();
    expect(send).toHaveBeenLastCalledWith(WINDOW_ACTIVITY_CHANNEL, false);

    destroyed = true;
    windowListeners.get("focus")?.();
    expect(send).toHaveBeenCalledTimes(5);

    windowListeners.get("closed")?.();
    expect(application.removeListener).toHaveBeenCalledWith(
      "did-become-active",
      applicationListeners.get("did-become-active"),
    );
    expect(application.removeListener).toHaveBeenCalledWith(
      "did-resign-active",
      applicationListeners.get("did-resign-active"),
    );
  });
});
