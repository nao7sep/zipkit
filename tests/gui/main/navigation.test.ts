/**
 * Tests for the renderer navigation guard — the boundary that keeps the SPA from
 * leaving its own origin or spawning child windows. The decisions are pure and
 * exported (the `setWindowOpenHandler` / `will-navigate` wiring in `createWindow`
 * needs a real BrowserWindow and isn't reachable headlessly), so they are pinned
 * here: every window open is denied, cross-origin navigation is treated as foreign
 * (the runtime calls `event.preventDefault()` on it), and same-origin is allowed.
 */

import { describe, expect, it } from "vitest";
import { isSameOrigin, windowOpenHandler } from "../../../src/gui/main/navigation.js";

describe("windowOpenHandler", () => {
  it("denies every renderer-initiated window open", () => {
    // The exact shape Electron's setWindowOpenHandler expects for a refusal.
    expect(windowOpenHandler()).toEqual({ action: "deny" });
  });
});

describe("isSameOrigin", () => {
  const app = "file:///Applications/ZipKit.app/Contents/renderer/index.html";

  it("allows same-origin navigation (reload / in-app routing)", () => {
    // Same file:// origin, different path/fragment — left to proceed.
    expect(isSameOrigin(app, "file:///Applications/ZipKit.app/Contents/renderer/index.html#x")).toBe(true);
    expect(isSameOrigin(app, "file:///Applications/ZipKit.app/Contents/renderer/other.html")).toBe(true);
    const dev = "http://localhost:5173/index.html";
    expect(isSameOrigin(dev, "http://localhost:5173/")).toBe(true);
  });

  it("treats a different origin as foreign (the guard will prevent it)", () => {
    expect(isSameOrigin(app, "https://evil.example.com/")).toBe(false);
    expect(isSameOrigin(app, "http://localhost:5173/")).toBe(false);
    expect(isSameOrigin("http://localhost:5173/index.html", "http://localhost:6006/")).toBe(false);
  });

  it("treats a malformed target as foreign rather than waving it through", () => {
    expect(isSameOrigin(app, "not a url")).toBe(false);
    expect(isSameOrigin(app, "")).toBe(false);
  });
});
