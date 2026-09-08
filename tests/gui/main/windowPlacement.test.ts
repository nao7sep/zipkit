import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyRestoredBounds,
  configureWindowPlacement,
  resolveWindowRestoration,
  usableWindowBounds,
} from "../../../src/gui/main/windowPlacement.js";
import type { WindowBounds, WindowPlacementRecord } from "../../../src/gui/shared/layout.js";

class FakeWindow extends EventEmitter {
  bounds: WindowBounds = { x: 10, y: 20, width: 1200, height: 780 };
  maximized = false; minimized = false; fullScreen = false;
  getBounds(): WindowBounds { return { ...this.bounds }; }
  setBounds(bounds: WindowBounds): void { this.bounds = { ...bounds }; }
  isMaximized(): boolean { return this.maximized; }
  isMinimized(): boolean { return this.minimized; }
  isFullScreen(): boolean { return this.fullScreen; }
}

function setup(mode: "normal" | "maximized" = "normal") {
  const win = new FakeWindow();
  const saved: WindowPlacementRecord[] = [];
  const controller = configureWindowPlacement(win, { normalBounds: win.getBounds(), mode }, async (record) => {
    saved.push(record);
  }, vi.fn());
  return { win, saved, controller };
}
afterEach(() => vi.useRealTimers());

describe("window restoration", () => {
  const minimum = { width: 900, height: 400 };
  const areas = [{ x: 0, y: 0, width: 1920, height: 1080 }, { x: -1280, y: 0, width: 1280, height: 1024 }];
  it("defaults to normal and accepts only whole, integral, minimum-sized rectangles", () => {
    expect(resolveWindowRestoration(null, minimum, areas)).toEqual({ normalBounds: null, mode: "normal" });
    const record: WindowPlacementRecord = { normalBounds: { x: -1200, y: 20, width: 1000, height: 700 }, mode: "maximized" };
    expect(resolveWindowRestoration(record, minimum, areas)).toEqual(record);
    expect(usableWindowBounds({ x: 10, y: 10, width: 899, height: 700 }, minimum, areas)).toBe(false);
    expect(usableWindowBounds({ x: 1200, y: 10, width: 900, height: 700 }, minimum, areas)).toBe(false);
    expect(usableWindowBounds({ x: 10.5, y: 10, width: 900, height: 700 }, minimum, areas)).toBe(false);
  });
  it("falls back as a unit when Electron adjusts restored bounds", () => {
    const win = new FakeWindow(); const opening = win.getBounds();
    vi.spyOn(win, "setBounds").mockImplementationOnce((bounds) => { win.bounds = { ...bounds, width: bounds.width - 1 }; });
    expect(applyRestoredBounds(win, { x: 50, y: 60, width: 1300, height: 850 }, vi.fn())).toBe(false);
    expect(win.bounds).toEqual(opening);
  });
});

describe("window capture", () => {
  it("suppresses startup and unarmed programmatic geometry", async () => {
    vi.useFakeTimers(); const { win, saved, controller } = setup();
    win.bounds = { x: 100, y: 100, width: 1300, height: 850 }; win.emit("move"); await controller.flush();
    controller.start(); win.emit("move"); win.emit("resize"); await vi.advanceTimersByTimeAsync(500); await controller.flush();
    expect(saved).toEqual([{ normalBounds: { x: 10, y: 20, width: 1200, height: 780 }, mode: "normal" }]);
  });
  it("debounces manual geometry and flushes the latest candidate", async () => {
    vi.useFakeTimers(); const { win, saved, controller } = setup(); controller.start();
    win.bounds = { x: 70, y: 80, width: 1350, height: 875 }; win.emit("will-move"); win.emit("move");
    win.emit("will-resize"); win.emit("resize"); await controller.flush();
    expect(saved).toEqual([{ normalBounds: win.bounds, mode: "normal" }]);
  });
  it("preserves normal bounds through maximize/unmaximize", async () => {
    vi.useFakeTimers(); const { win, saved, controller } = setup(); controller.start();
    win.maximized = true; win.bounds = { x: 0, y: 0, width: 1920, height: 1080 }; win.emit("maximize"); await Promise.resolve();
    expect(saved.at(-1)?.mode).toBe("maximized"); expect(saved.at(-1)?.normalBounds).toEqual({ x: 10, y: 20, width: 1200, height: 780 });
    win.maximized = false; win.bounds = { x: 80, y: 90, width: 1400, height: 900 }; win.emit("unmaximize");
    await vi.advanceTimersByTimeAsync(400); expect(saved.at(-1)).toEqual({ normalBounds: win.bounds, mode: "normal" });
  });
  it.each(["minimized", "fullScreen"] as const)("preserves stable state on %s close", async (field) => {
    const { win, saved, controller } = setup("maximized"); controller.start(); win[field] = true;
    win.emit(field === "minimized" ? "minimize" : "enter-full-screen"); win.bounds = { x: 0, y: 0, width: 300, height: 200 };
    await controller.flush(); expect(saved.at(-1)).toEqual({ normalBounds: { x: 10, y: 20, width: 1200, height: 780 }, mode: "maximized" });
  });
});
