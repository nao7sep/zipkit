import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mainWindowBackground, mainWindowOptions } from "../../../src/gui/main/window-options.js";
import { minWindowHeight, minWindowWidth } from "../../../src/gui/shared/layout.js";

describe("mainWindowOptions", () => {
  const options = mainWindowOptions("/tmp/preload.mjs", false);

  it("uses Electron-owned bounds persistence for the stable main window", () => {
    expect(options.name).toBe("main");
    expect(options.windowStatePersistence).toEqual({
      bounds: true,
      displayMode: process.platform === "win32",
    });
  });

  it("preserves the designed opening and derived minimum sizes", () => {
    expect(options.width).toBe(1200);
    expect(options.height).toBe(780);
    expect(options.minWidth).toBe(minWindowWidth());
    expect(options.minHeight).toBe(minWindowHeight());
  });

  it("preserves hidden startup, background, and renderer isolation", () => {
    expect(options.show).toBe(false);
    expect(options.backgroundColor).toBe(mainWindowBackground(false));
    expect(mainWindowOptions("/tmp/preload.mjs", true).backgroundColor).toBe(mainWindowBackground(true));
    expect(options.webPreferences).toEqual({
      preload: "/tmp/preload.mjs",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    });
  });

  it("paints index.css's --bg in each theme so the first frame never flashes", () => {
    const css = readFileSync(resolve("src/gui/renderer/src/index.css"), "utf8");
    const light = css.slice(css.search(/^:root\s*\{/m));
    const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark) {"));
    const bg = (block: string) => block.match(/--bg:\s*(#[0-9a-f]{6});/i)?.[1]?.toLowerCase();
    expect(mainWindowBackground(false)).toBe(bg(light));
    expect(mainWindowBackground(true)).toBe(bg(dark));
  });
});
