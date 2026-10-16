// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { buildShortcuts, hasMod, modifierWord, shadowsMacTextBinding } from "../../../src/gui/renderer/src/shortcuts";

describe("keyboard shortcut catalogue", () => {
  it("names the help alias and both bound removal keys with canonical key names", () => {
    const items = buildShortcuts("Cmd").flatMap((group) => group.items);
    expect(items).toContainEqual({ keys: "Cmd+Question", description: "shortcuts.showShortcuts" });
    expect(items).toContainEqual({ keys: "Delete/Backspace", description: "shortcuts.removeJob" });
  });
});

describe("shortcut groups", () => {
  it("groups by where the keys work: the modifier chords anywhere, the plain keys in the job list", () => {
    const [general, jobList] = buildShortcuts("Cmd");
    expect(general!.title).toBe("shortcuts.general");
    expect(general!.items.every((item) => item.keys.startsWith("Cmd+"))).toBe(true);
    expect(general!.items.map((item) => item.description)).toContain("shortcuts.createSelected");
    expect(jobList!.title).toBe("shortcuts.jobList");
    expect(jobList!.items.some((item) => item.keys.includes("Cmd+"))).toBe(false);
    expect(jobList!.items.map((item) => item.keys)).toEqual(expect.arrayContaining(["Delete/Backspace", "Escape"]));
  });
});

describe("platform modifiers", () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { key: "n", ...init });

  it("names Cmd on macOS and Ctrl on Windows", () => {
    expect(modifierWord("darwin")).toBe("Cmd");
    expect(modifierWord("win32")).toBe("Ctrl");
  });

  it("accepts Cmd or Ctrl but not AltGr, which Windows delivers as Ctrl+Alt", () => {
    expect(hasMod(key({ metaKey: true }))).toBe(true);
    expect(hasMod(key({ ctrlKey: true }))).toBe(true);
    expect(hasMod(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(hasMod(key({}))).toBe(false);
  });

  it("leaves Ctrl to the macOS text system and keeps it as the Windows binding", () => {
    expect(shadowsMacTextBinding(key({ ctrlKey: true }), true)).toBe(true);
    expect(shadowsMacTextBinding(key({ metaKey: true }), true)).toBe(false);
    expect(shadowsMacTextBinding(key({ ctrlKey: true }), false)).toBe(false);
  });
});
