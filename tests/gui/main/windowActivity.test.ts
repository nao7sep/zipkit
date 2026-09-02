import { describe, expect, it, vi } from "vitest";
import { configureWindowActivity } from "../../../src/gui/main/windowActivity.js";
import { WINDOW_ACTIVITY_CHANNEL } from "../../../src/gui/shared/api.js";

describe("native window activity transport", () => {
  it("publishes focus, blur, and the current state after each renderer load", () => {
    const windowListeners = new Map<string, () => void>();
    const contentListeners = new Map<string, () => void>();
    const send = vi.fn();
    let focused = false;
    let destroyed = false;
    const window = {
      on: vi.fn((event: string, listener: () => void) => {
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

    configureWindowActivity(window as unknown as Electron.BrowserWindow);
    contentListeners.get("did-finish-load")?.();
    expect(send).toHaveBeenLastCalledWith(WINDOW_ACTIVITY_CHANNEL, false);
    focused = true;
    windowListeners.get("focus")?.();
    expect(send).toHaveBeenLastCalledWith(WINDOW_ACTIVITY_CHANNEL, true);
    windowListeners.get("blur")?.();
    expect(send).toHaveBeenLastCalledWith(WINDOW_ACTIVITY_CHANNEL, false);

    destroyed = true;
    windowListeners.get("focus")?.();
    expect(send).toHaveBeenCalledTimes(3);
  });
});
