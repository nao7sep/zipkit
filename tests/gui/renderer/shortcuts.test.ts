// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { buildShortcuts } from "../../../src/gui/renderer/src/shortcuts";

describe("keyboard shortcut catalogue", () => {
  it("names the help alias and both bound removal keys with canonical key names", () => {
    const items = buildShortcuts("Cmd").flatMap((group) => group.items);
    expect(items).toContainEqual({ keys: "Cmd+Question", description: "shortcuts.showShortcuts" });
    expect(items).toContainEqual({ keys: "Delete/Backspace", description: "shortcuts.removeJob" });
  });
});
