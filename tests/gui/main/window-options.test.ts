import { describe, expect, it } from "vitest";
import { mainWindowOptions } from "../../../src/gui/main/window-options.js";
import { minWindowHeight, minWindowWidth } from "../../../src/gui/shared/layout.js";

describe("mainWindowOptions", () => {
  const options = mainWindowOptions("/tmp/preload.mjs");

  it("uses Electron-owned bounds persistence for the stable main window", () => {
    expect(options.name).toBe("main");
    expect(options.windowStatePersistence).toEqual({ bounds: true, displayMode: false });
  });

  it("preserves the designed opening and derived minimum sizes", () => {
    expect(options.width).toBe(1200);
    expect(options.height).toBe(780);
    expect(options.minWidth).toBe(minWindowWidth());
    expect(options.minHeight).toBe(minWindowHeight());
  });

  it("preserves hidden startup, background, and renderer isolation", () => {
    expect(options.show).toBe(false);
    expect(options.backgroundColor).toBe("#16170f");
    expect(options.webPreferences).toEqual({
      preload: "/tmp/preload.mjs",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    });
  });
});
