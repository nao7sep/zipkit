import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { CATALOGUES } from "../../../src/gui/shared/i18n/catalogues";
import { LANGUAGES } from "../../../src/gui/shared/i18n/languages";
import { createTranslator } from "../../../src/gui/shared/i18n/translate";

vi.mock("electron", () => ({ Menu: {} }));

const { buildAppMenuTemplate } = await import("../../../src/gui/main/menu.js");

function labels(items: MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => [
    ...(item.label ? [item.label] : []),
    ...(Array.isArray(item.submenu) ? labels(item.submenu) : []),
  ]);
}

const KEYS = new Set(Object.keys(CATALOGUES.en));

describe("application menu", () => {
  it.each(["darwin", "win32"] as const)("labels every item from the catalogue on %s", (platform) => {
    for (const language of LANGUAGES) {
      const drawn = labels(buildAppMenuTemplate(createTranslator(language), platform));
      expect(drawn.filter((label) => KEYS.has(label) || label.includes("{")), language).toEqual([]);
    }
  });

  it("titles the Edit menu in the interface language and keeps the system roles", () => {
    const menu = buildAppMenuTemplate(createTranslator("ja"), "darwin");
    const edit = menu.find((item) => item.label === createTranslator("ja").t("nativeMenu.edit"))!;
    const roles = (edit.submenu as MenuItemConstructorOptions[]).map((item) => item.role).filter(Boolean);
    expect(roles).toEqual(expect.arrayContaining(["undo", "redo", "cut", "copy", "paste", "selectAll"]));
    expect(menu.some((item) => item.role === "windowMenu")).toBe(true);
  });

  it("leads with the app menu only on macOS", () => {
    expect(buildAppMenuTemplate(createTranslator("en"), "darwin")[0]?.label).toBe("ZipKit");
    expect(buildAppMenuTemplate(createTranslator("en"), "win32")[0]?.label).toBe("File");
  });
});
