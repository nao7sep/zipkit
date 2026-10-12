import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { captureJobEdits } from "../../../src/gui/main/job-edit-capture.js";
import { QUIT_BOUNDS_MS } from "../../../src/gui/main/quit.js";
import { StepTimeout } from "../../../src/gui/main/step-timeout.js";
const events = vi.hoisted(() => ({ bus: null as EventEmitter | null }));
vi.mock("electron", () => ({ ipcMain: {
  on: (name: string, listener: (...args: unknown[]) => void) => events.bus!.on(name, listener),
  removeListener: (name: string, listener: (...args: unknown[]) => void) => events.bus!.removeListener(name, listener),
} }));
afterEach(() => vi.useRealTimers());

it("rejects a missing capture, ignores stale and foreign acknowledgments, and cleans its listeners", async () => {
  events.bus = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), { send: vi.fn() });
  const win = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  vi.useFakeTimers();
  const first = captureJobEdits(win).catch((error: unknown) => error);
  const old = `zipkit:jobEditsCaptured:${contents.send.mock.calls[0]![1]}`;
  await vi.advanceTimersByTimeAsync(QUIT_BOUNDS_MS.capture);
  expect(await first).toBeInstanceOf(StepTimeout);
  expect(events.bus.listenerCount(old)).toBe(0);
  let complete = false;
  const next = captureJobEdits(win).then(() => { complete = true; });
  const current = `zipkit:jobEditsCaptured:${contents.send.mock.calls[1]![1]}`;
  events.bus.emit(old, { sender: contents }, true);
  events.bus.emit(current, { sender: {} }, true);
  await Promise.resolve(); expect(complete).toBe(false);
  events.bus.emit(current, { sender: contents }, true);
  await next;
  expect(events.bus.listenerCount(current)).toBe(0);
  expect(contents.listenerCount("destroyed")).toBe(0);
});

it("treats editor destruction during capture as failure", async () => {
  events.bus = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), { send: vi.fn() });
  const work = captureJobEdits({ isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow);
  contents.emit("destroyed");
  await expect(work).rejects.toThrow("before its edits were captured");
  expect(events.bus.eventNames()).toEqual([]);
});

it("Mac close and Quit join one capture before either destroys the editor", async () => {
  events.bus = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), { send: vi.fn() });
  const win = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  const close = captureJobEdits(win);
  const quit = captureJobEdits(win);
  expect(quit).toBe(close);
  void close.then(() => { contents.emit("destroyed"); });
  const reply = `zipkit:jobEditsCaptured:${contents.send.mock.calls[0]![1]}`;
  events.bus.emit(reply, { sender: contents }, true);
  await expect(Promise.all([close, quit])).resolves.toEqual([undefined, undefined]);
  expect(contents.send).toHaveBeenCalledOnce();
});
