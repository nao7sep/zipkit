import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAppMessageDialogDocument, showAppQuestionDialog } from "../../../src/gui/main/startup-dialog.js";

const windows = vi.hoisted(() => ([] as Array<{
  events: EventEmitter;
  contents: EventEmitter;
  destroyed: boolean;
  showed: boolean;
  html: string;
}>));
const controls = vi.hoisted(() => ({ load: null as Promise<void> | null, failure: null as Error | null }));
vi.mock("electron", () => ({
  BrowserWindow: class {
    state = { events: new EventEmitter(), contents: new EventEmitter(), destroyed: false, showed: false, html: "" };
    constructor() { windows.push(this.state); }
    webContents = Object.assign(this.state.contents, { executeJavaScript: async () => 260 });
    once(event: string, listener: (...args: unknown[]) => void) { this.state.events.once(event, listener); }
    async loadURL(url: string) {
      this.state.html = decodeURIComponent(url.split(",")[1]!);
      if (controls.failure) throw controls.failure;
      if (controls.load) await controls.load;
    }
    isDestroyed() { return this.state.destroyed; }
    destroy() { this.state.destroyed = true; this.state.events.emit("closed"); }
    getSize() { return [520, 280]; }
    getContentSize() { return [520, 250]; }
    setSize() {}
    show() { this.state.showed = true; }
  },
}));
vi.mock("../../../src/gui/main/i18n.js", () => ({ mainTranslator: () => ({ language: "en", t: (key: string) => key }), settledTranslator: vi.fn() }));
vi.mock("../../../src/gui/main/theme.js", () => ({ windowBackground: () => "#fff" }));
beforeEach(() => { windows.length = 0; controls.load = null; controls.failure = null; });
const options = (signal: AbortSignal) => ({ title: "Queue not saved", message: "Keep work", labels: ["Retry", "Quit anyway", "Cancel"], defaultId: 0, cancelId: 2, signal });

describe("standalone quit question lifetime", () => {
  it("settles Cancel on abort even while window loading is held, with no later show", async () => {
    let release!: () => void;
    controls.load = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const result = showAppQuestionDialog(options(controller.signal));
    expect(windows).toHaveLength(1);
    controller.abort();
    await expect(result).resolves.toBe(2);
    expect(windows[0]!.destroyed).toBe(true);
    release();
    await Promise.resolve();
    expect(windows[0]!.showed).toBe(false);
  });

  it("returns the chosen explicit result once and ignores subsequent close/abort", async () => {
    const controller = new AbortController();
    const result = showAppQuestionDialog(options(controller.signal));
    const event = { preventDefault: vi.fn() };
    windows[0]!.contents.emit("will-navigate", event, "zipkit-dialog-choice://1");
    controller.abort();
    await expect(result).resolves.toBe(1);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(windows[0]!.destroyed).toBe(true);
  });

  it("Escape takes Cancel and never chooses discard", async () => {
    const controller = new AbortController();
    const result = showAppQuestionDialog(options(controller.signal));
    const event = { preventDefault: vi.fn() };
    windows[0]!.contents.emit("before-input-event", event, { key: "Escape" });
    await expect(result).resolves.toBe(2);
  });

  it("a failed presenter rejects and destroys its standalone window", async () => {
    const controller = new AbortController();
    controls.failure = new Error("load failed");
    await expect(showAppQuestionDialog(options(controller.signal))).rejects.toBe(controls.failure);
    expect(windows[0]!.destroyed).toBe(true);
    expect(windows[0]!.showed).toBe(false);
  });

  it("a held load fails within its bound and closes the standalone owner", async () => {
    vi.useFakeTimers();
    try {
      controls.load = new Promise<void>(() => {});
      const controller = new AbortController();
      const result = showAppQuestionDialog(options(controller.signal));
      const failed = expect(result).rejects.toThrow("did not load within 5000 ms");
      await vi.advanceTimersByTimeAsync(5_000);
      await failed;
      expect(windows[0]!.destroyed).toBe(true);
      expect(windows[0]!.showed).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("a pre-aborted session creates no window", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(showAppQuestionDialog(options(controller.signal))).resolves.toBe(2);
    expect(windows).toHaveLength(0);
  });

  it("escapes choice labels in the existing shell and focuses only its safe default", () => {
    const html = buildAppMessageDialogDocument({ lang: "en", title: "Quit?", message: "message", buttonLabel: "unused", regionLabel: "details", choices: { labels: ["Quit <anyway>", "Keep working"], defaultId: 1 } });
    expect(html).toContain("Quit &lt;anyway&gt;");
    expect(html).toContain('autofocus onclick="location.href=\'zipkit-dialog-choice://1\'"');
    expect(html.match(/autofocus/g)).toHaveLength(1);
  });
});
