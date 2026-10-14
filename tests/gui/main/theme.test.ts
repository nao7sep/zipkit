import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const windows: Array<{ setBackgroundColor: ReturnType<typeof vi.fn>; isDestroyed: () => boolean }> = [];
  const listeners: Record<string, () => void> = {};
  const nativeTheme = {
    themeSource: "system" as string,
    shouldUseDarkColors: false,
    on: vi.fn((event: string, listener: () => void) => {
      listeners[event] = listener;
    }),
  };
  return { windows, listeners, nativeTheme };
});

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => electron.windows },
  nativeTheme: electron.nativeTheme,
}));

import { applyThemePreference, followOsThemeChanges, resolveSystemAppearance, windowBackground } from "../../../src/gui/main/theme.js";

beforeEach(() => {
  electron.windows.splice(0);
  electron.nativeTheme.themeSource = "system";
  electron.nativeTheme.shouldUseDarkColors = false;
});

describe("theme", () => {
  it("hands the saved choice to Electron as the one theme authority, System for anything unknown", () => {
    applyThemePreference("light");
    expect(electron.nativeTheme.themeSource).toBe("light");
    applyThemePreference("sepia");
    expect(electron.nativeTheme.themeSource).toBe("system");
  });

  it("repaints window backgrounds in the resolved theme, on Save and on an OS change", () => {
    const window = { setBackgroundColor: vi.fn(), isDestroyed: () => false };
    electron.windows.push(window);
    electron.nativeTheme.shouldUseDarkColors = true;
    applyThemePreference("dark");
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(windowBackground(true));

    followOsThemeChanges();
    electron.nativeTheme.shouldUseDarkColors = false;
    electron.listeners.updated?.();
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(windowBackground(false));
  });
});

describe("what System resolves to now", () => {
  const probe = { following: false, dark: true, platform: "darwin" as NodeJS.Platform, macInterfaceStyle: () => "", systemUiDark: false };

  it("reads Electron's own answer while the app follows the OS", () => {
    expect(resolveSystemAppearance({ ...probe, following: true, dark: true })).toBe("dark");
    expect(resolveSystemAppearance({ ...probe, following: true, dark: false, macInterfaceStyle: () => "Dark" })).toBe("light");
  });

  it("asks macOS directly under a forced theme, whatever the forced theme paints", () => {
    expect(resolveSystemAppearance({ ...probe, macInterfaceStyle: () => "Dark", dark: false })).toBe("dark");
    expect(resolveSystemAppearance({ ...probe, macInterfaceStyle: () => "", dark: true })).toBe("light");
  });

  it("uses Windows' system theme under a forced theme", () => {
    expect(resolveSystemAppearance({ ...probe, platform: "win32", systemUiDark: true, dark: false })).toBe("dark");
    expect(resolveSystemAppearance({ ...probe, platform: "win32", systemUiDark: false, dark: true })).toBe("light");
  });
});
