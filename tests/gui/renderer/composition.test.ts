// @vitest-environment jsdom
/**
 * Tests the IME composition guard (text-input-and-IME conventions). Two signals:
 * the event's own `isComposing` (and the legacy `keyCode === 229` fallback), and a
 * document-level flag that goes true on `compositionstart` and stays true for one
 * animation frame past `compositionend` — covering the WebKit seam where the final
 * keydown fires after compositionend and would otherwise slip the guard.
 */

import { afterEach, describe, expect, it } from "vitest";
import { isComposing } from "../../../src/gui/renderer/src/composition";

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

// Leave the module-level flag clear after each test (compositionend + one frame).
afterEach(async () => {
  window.dispatchEvent(new Event("compositionend"));
  await nextFrame();
});

describe("isComposing — per-event signals", () => {
  it("is true when the event's own isComposing is set (raw or React-synthetic)", () => {
    expect(isComposing({ isComposing: true } as unknown as KeyboardEvent)).toBe(true);
    expect(isComposing({ nativeEvent: { isComposing: true } } as unknown as KeyboardEvent)).toBe(true);
  });
  it("is true for the legacy keyCode === 229 fallback", () => {
    expect(isComposing({ keyCode: 229 } as unknown as KeyboardEvent)).toBe(true);
  });
  it("is false for an ordinary keystroke outside composition", () => {
    expect(isComposing({ isComposing: false, keyCode: 13 } as unknown as KeyboardEvent)).toBe(false);
  });
});

describe("isComposing — document-level flag with the post-compositionend tail", () => {
  it("guards any keystroke while composing, and one frame past compositionend", async () => {
    const plain = { isComposing: false } as unknown as KeyboardEvent;

    window.dispatchEvent(new Event("compositionstart"));
    expect(isComposing(plain)).toBe(true); // flag set, even for an event that says false

    window.dispatchEvent(new Event("compositionend"));
    expect(isComposing(plain)).toBe(true); // still guarded for the trailing keydown

    await nextFrame();
    expect(isComposing(plain)).toBe(false); // flag clears one frame later
  });
});
