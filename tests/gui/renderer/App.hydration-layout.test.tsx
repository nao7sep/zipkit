// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { App } from "../../../src/gui/renderer/src/App";
import { DialogHost } from "../../../src/gui/renderer/src/components/DialogHost";
import type { Job, ZipKitGuiApi } from "../../../src/gui/shared/api";
import { DEFAULT_LAYOUT } from "../../../src/gui/shared/layout";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec";

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

const job = (id: string): Job => ({
  id,
  inputs: [`/${id}`],
  options: DEFAULT_OPTIONS,
  intent: "save",
  state: "ready",
});

function api(overrides: Partial<ZipKitGuiApi> = {}): ZipKitGuiApi {
  return {
    chooseInputs: vi.fn(async () => []),
    chooseOutputDir: vi.fn(async () => ""),
    pathForFile: vi.fn(() => ""),
    platform: "darwin",
    getSettings: vi.fn(async () => ({ defaults: DEFAULT_OPTIONS, uiFontFamily: "" })),
    setSettings: vi.fn(async () => {}),
    getLayout: vi.fn(async () => DEFAULT_LAYOUT),
    setLayout: vi.fn(async () => {}),
    addJob: vi.fn(async () => "new"),
    updateJob: vi.fn(async () => {}),
    removeJob: vi.fn(async () => {}),
    runJob: vi.fn(async () => {}),
    removeArchive: vi.fn(async () => {}),
    trashOriginals: vi.fn(async () => {}),
    cancelJob: vi.fn(async () => {}),
    getPlan: vi.fn(async () => null),
    getQueue: vi.fn(async () => []),
    onQueue: vi.fn(() => () => {}),
    verify: vi.fn(),
    reveal: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    appInfo: vi.fn(async () => ({ name: "ZipKit", version: "0.1.0" })),
    openExternal: vi.fn(),
    reportError: vi.fn(),
    ...overrides,
  };
}

function renderApp(bridge: ZipKitGuiApi) {
  Object.defineProperty(window, "zipkit", { configurable: true, value: bridge });
  return render(
    <DialogHost>
      <App />
    </DialogHost>,
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("required app hydration", () => {
  it("blocks the ordinary interface after a failed load and retries the complete hydration", async () => {
    const getSettings = vi
      .fn<ZipKitGuiApi["getSettings"]>()
      .mockRejectedValueOnce(new Error("settings unavailable"))
      .mockResolvedValueOnce({ defaults: DEFAULT_OPTIONS, uiFontFamily: "" });
    const unsubscribes = [vi.fn(), vi.fn()];
    const onQueue = vi
      .fn<ZipKitGuiApi["onQueue"]>()
      .mockImplementationOnce(() => unsubscribes[0]!)
      .mockImplementationOnce(() => unsubscribes[1]!);
    const bridge = api({ getSettings, onQueue });

    renderApp(bridge);

    const failure = await screen.findByRole("alert", { name: "ZipKit couldn’t load" });
    expect(failure.textContent).toContain("no partial app state is shown");
    expect(screen.queryByRole("heading", { name: "Jobs" })).toBeNull();
    expect(bridge.reportError).toHaveBeenCalledWith(
      "load required application state",
      expect.objectContaining({ message: "settings unavailable" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));

    expect(await screen.findByRole("heading", { name: "Jobs" })).toBeTruthy();
    expect(bridge.getQueue).toHaveBeenCalledTimes(2);
    expect(getSettings).toHaveBeenCalledTimes(2);
    expect(bridge.getLayout).toHaveBeenCalledTimes(2);
    expect(onQueue).toHaveBeenCalledTimes(2);
    expect(unsubscribes[0]).toHaveBeenCalledOnce();
    expect(unsubscribes[1]).not.toHaveBeenCalled();
  });

  it("uses a queue update received during hydration instead of overwriting it with an older snapshot", async () => {
    let publishQueue: ((jobs: Job[]) => void) | undefined;
    let resolveSnapshot: ((jobs: Job[]) => void) | undefined;
    const getQueue = vi.fn(() => new Promise<Job[]>((resolve) => {
      resolveSnapshot = resolve;
    }));
    const bridge = api({
      getQueue,
      onQueue: vi.fn((callback) => {
        publishQueue = callback;
        return () => {};
      }),
    });

    renderApp(bridge);
    expect(screen.getByRole("status", { name: "Loading ZipKit…" })).toBeTruthy();

    publishQueue?.([job("newer")]);
    resolveSnapshot?.([job("older")]);

    expect(await screen.findByText("newer")).toBeTruthy();
    expect(screen.queryByText("older")).toBeNull();
  });
});

describe("pane-layout persistence results", () => {
  it("keeps the live layout after failure and clears its shell alert on a later successful save", async () => {
    const setLayout = vi
      .fn<ZipKitGuiApi["setLayout"]>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    renderApp(api({ setLayout }));
    const splitter = await screen.findByRole("separator", { name: "Resize Jobs pane" });

    fireEvent.keyDown(splitter, { key: "ArrowRight" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("current layout is still in use");
    expect(alert.style.flexShrink).toBe("0");
    expect(document.querySelector<HTMLElement>("[data-app-content-viewport]")?.style.overflow)
      .toBe("auto");
    expect(document.querySelector<HTMLElement>("[data-app-pane-grid]")?.style.minHeight)
      .toBe("360px");
    expect(splitter.getAttribute("aria-valuenow")).toBe("298");
    expect(setLayout).toHaveBeenNthCalledWith(1, { ...DEFAULT_LAYOUT, jobsWidth: 298 });

    fireEvent.keyDown(splitter, { key: "ArrowRight" });

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(splitter.getAttribute("aria-valuenow")).toBe("308");
    expect(setLayout).toHaveBeenNthCalledWith(2, { ...DEFAULT_LAYOUT, jobsWidth: 308 });
  });

  it("allows dismissal without rolling back the unsaved in-memory layout", async () => {
    const setLayout = vi.fn<ZipKitGuiApi["setLayout"]>().mockRejectedValue(new Error("read only"));
    renderApp(api({ setLayout }));
    const splitter = await screen.findByRole("separator", { name: "Resize Jobs pane" });
    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss pane layout save error" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(splitter.getAttribute("aria-valuenow")).toBe("298");
  });
});
