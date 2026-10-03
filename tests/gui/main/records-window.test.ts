import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeWindow {
    static created: FakeWindow[] = [];
    destroyed = false;
    minimized = false;
    shown = 0;
    focused = 0;
    restored = 0;
    sent: string[] = [];
    private readonly closedListeners: (() => void)[] = [];
    readonly webContents = {
      isDestroyed: () => this.destroyed,
      send: (channel: string) => this.sent.push(channel),
    };
    constructor(readonly options: Record<string, unknown>) {
      FakeWindow.created.push(this);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isMinimized(): boolean {
      return this.minimized;
    }
    restore(): void {
      this.restored++;
      this.minimized = false;
    }
    show(): void {
      this.shown++;
    }
    focus(): void {
      this.focused++;
    }
    destroy(): void {
      this.close();
    }
    close(): void {
      this.destroyed = true;
      for (const listener of this.closedListeners.splice(0)) listener();
    }
    once(event: string, listener: () => void): void {
      if (event === "closed") this.closedListeners.push(listener);
    }
  }
  return {
    FakeWindow,
    load: vi.fn<(window: unknown, page: string) => Promise<void>>(),
    recover: vi.fn((_name: string, create: () => unknown) => create()),
    minimum: vi.fn(),
    activity: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: mocks.FakeWindow,
  nativeTheme: { shouldUseDarkColors: false },
}));
vi.mock("../../../src/gui/main/renderer-page.js", () => ({ loadRendererPage: mocks.load }));
vi.mock("../../../src/gui/main/window-state-recovery.js", () => ({
  createWindowWithUsablePersistedBounds: mocks.recover,
}));
vi.mock("../../../src/gui/main/window-minimum.js", () => ({ configureWindowMinimum: mocks.minimum }));
vi.mock("../../../src/gui/main/windowActivity.js", () => ({ configureWindowActivity: mocks.activity }));
vi.mock("../../../src/gui/main/i18n.js", () => ({ mainTranslator: () => ({ t: (key: string) => `[${key}]` }) }));
vi.mock("../../../src/gui/main/runtime.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { notifyRecordsChanged, openRecordsWindow } from "../../../src/gui/main/records-window.js";
import { RECORDS_CHANGED_CHANNEL } from "../../../src/gui/shared/api.js";
import { recordsWindowMinHeight, recordsWindowMinWidth } from "../../../src/gui/shared/layout.js";

type Fake = InstanceType<typeof mocks.FakeWindow>;
const windows = (): Fake[] => mocks.FakeWindow.created;

describe("the Records window", () => {
  beforeEach(() => {
    for (const window of windows().splice(0)) if (!window.destroyed) window.close();
    mocks.load.mockReset();
    mocks.load.mockResolvedValue();
    mocks.recover.mockClear();
    mocks.minimum.mockClear();
  });

  it("opens one window with its own placement, titled in the interface language, shown once its page loads", async () => {
    let loaded!: () => void;
    mocks.load.mockReturnValueOnce(new Promise<void>((resolve) => (loaded = resolve)));
    const opening = openRecordsWindow();
    expect(windows()).toHaveLength(1);
    const [window] = windows();
    expect(mocks.recover).toHaveBeenCalledWith("records", expect.any(Function));
    expect(window!.options).toMatchObject({ name: "records", title: "[records.title]", show: false });
    expect(mocks.load).toHaveBeenCalledWith(window, "records.html");
    expect(mocks.minimum.mock.calls[0]![1]()).toEqual({ width: recordsWindowMinWidth(), height: recordsWindowMinHeight() });
    expect(window!.shown).toBe(0);
    loaded();
    await opening;
    expect(window!.shown).toBe(1);
  });

  it("brings the open window forward instead of opening another, even while it is still loading", async () => {
    let loaded!: () => void;
    mocks.load.mockReturnValueOnce(new Promise<void>((resolve) => (loaded = resolve)));
    const first = openRecordsWindow();
    const second = openRecordsWindow();
    loaded();
    await Promise.all([first, second]);
    expect(windows()).toHaveLength(1);

    const [window] = windows();
    window!.minimized = true;
    await openRecordsWindow();
    expect(windows()).toHaveLength(1);
    expect(window!.restored).toBe(1);
    expect(window!.focused).toBeGreaterThanOrEqual(2);
  });

  it("opens a new window once the last one has closed", async () => {
    await openRecordsWindow();
    windows()[0]!.close();
    await openRecordsWindow();
    expect(windows()).toHaveLength(2);
    expect(windows()[1]!.destroyed).toBe(false);
  });

  it("tells only an open window that a record was stored", async () => {
    notifyRecordsChanged();
    await openRecordsWindow();
    notifyRecordsChanged();
    expect(windows()[0]!.sent).toEqual([RECORDS_CHANGED_CHANNEL]);
    windows()[0]!.close();
    notifyRecordsChanged();
    expect(windows()[0]!.sent).toEqual([RECORDS_CHANGED_CHANNEL]);
  });

  it("destroys a window whose page failed to load and rejects, so the next open starts afresh", async () => {
    const failure = new Error("no page");
    mocks.load.mockRejectedValueOnce(failure);
    await expect(openRecordsWindow()).rejects.toBe(failure);
    expect(windows()[0]!.destroyed).toBe(true);
    await openRecordsWindow();
    expect(windows()).toHaveLength(2);
  });
});
