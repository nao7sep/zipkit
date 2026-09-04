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
    onWindowActivityChanged: vi.fn(() => () => {}),
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
    const firstWidth = Number(splitter.getAttribute("aria-valuenow"));
    expect(firstWidth).toBeGreaterThan(DEFAULT_LAYOUT.jobsWidth);
    expect(setLayout).toHaveBeenNthCalledWith(1, { ...DEFAULT_LAYOUT, jobsWidth: firstWidth });

    fireEvent.keyDown(splitter, { key: "ArrowRight" });

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    const secondWidth = Number(splitter.getAttribute("aria-valuenow"));
    expect(secondWidth).toBeGreaterThan(firstWidth);
    expect(setLayout).toHaveBeenNthCalledWith(2, { ...DEFAULT_LAYOUT, jobsWidth: secondWidth });
  });

  it("allows dismissal without rolling back the unsaved in-memory layout", async () => {
    const setLayout = vi.fn<ZipKitGuiApi["setLayout"]>().mockRejectedValue(new Error("read only"));
    renderApp(api({ setLayout }));
    const splitter = await screen.findByRole("separator", { name: "Resize Jobs pane" });
    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Close pane layout save result" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(splitter.getAttribute("aria-valuenow")).toBe("298");
  });
});

describe("selected-job IPC ownership", () => {
  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  it("blocks a false empty report when plan hydration rejects and offers retry", async () => {
    const getPlan = vi.fn<ZipKitGuiApi["getPlan"]>().mockRejectedValue(new Error("EACCES /private/tmp/ZIPKIT_PLAN_SENTINEL"));
    const bridge = api({ getQueue: vi.fn(async () => [job("plan-job")]), getPlan });
    renderApp(bridge);
    fireEvent.click(await screen.findByRole("option"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("plan could not be loaded");
    expect(alert.textContent).not.toContain("ZIPKIT_PLAN_SENTINEL");
    expect(screen.getByRole("button", { name: "Retry plan" })).toBeTruthy();
    expect(bridge.reportError).toHaveBeenCalledWith("load selected job plan", expect.objectContaining({ message: expect.stringContaining("ZIPKIT_PLAN_SENTINEL") }));
  });

  it("retains a job-local authored result when run rejects", async () => {
    const runJob = vi.fn<ZipKitGuiApi["runJob"]>().mockRejectedValue(new Error("EACCES /private/tmp/ZIPKIT_RUN_SENTINEL"));
    const bridge = api({ getQueue: vi.fn(async () => [job("run-job")]), runJob });
    renderApp(bridge);
    fireEvent.click(await screen.findByRole("option"));
    fireEvent.click(await screen.findByRole("button", { name: "Create archive" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("archive could not be started");
    expect(alert.textContent).not.toContain("ZIPKIT_RUN_SENTINEL");
    expect(bridge.reportError).toHaveBeenCalledWith("run job", expect.objectContaining({ message: expect.stringContaining("ZIPKIT_RUN_SENTINEL") }));
  });

  it("keeps the previous intent and retains authored copy when the mutation rejects", async () => {
    const updateJob = vi.fn<ZipKitGuiApi["updateJob"]>().mockRejectedValue(new Error("EACCES /private/tmp/ZIPKIT_INTENT_SENTINEL"));
    const bridge = api({ getQueue: vi.fn(async () => [job("intent-job")]), updateJob });
    renderApp(bridge);
    fireEvent.click(await screen.findByRole("option"));
    const intent = await screen.findByRole("combobox", { name: "Intent" });
    fireEvent.change(intent, { target: { value: "archive-and-trash" } });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("previous intent is still active");
    expect(alert.textContent).not.toContain("ZIPKIT_INTENT_SENTINEL");
    expect((intent as HTMLSelectElement).value).toBe("save");
    expect(bridge.reportError).toHaveBeenCalledWith("update job intent", expect.objectContaining({ message: expect.stringContaining("ZIPKIT_INTENT_SENTINEL") }));
  });

  it("does not let an older direct-action failure replace a newer success", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const reveal = vi.fn<ZipKitGuiApi["reveal"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const selected = { ...job("reveal-job"), state: "done" as const, output: "/out/archive.zip" };
    const bridge = api({ getQueue: vi.fn(async () => [selected]), reveal });
    renderApp(bridge);
    fireEvent.click(await screen.findByRole("option"));
    const button = await screen.findByRole("button", { name: "Reveal in file manager" });

    fireEvent.click(button);
    fireEvent.click(button);
    second.resolve();
    first.reject(new Error("EACCES /private/tmp/STALE-ZIPKIT-REVEAL"));

    await waitFor(() => expect(bridge.reportError).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retains a newer direct-action failure after an older success", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const reveal = vi.fn<ZipKitGuiApi["reveal"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const selected = { ...job("reveal-job"), state: "done" as const, output: "/out/archive.zip" };
    const bridge = api({ getQueue: vi.fn(async () => [selected]), reveal });
    renderApp(bridge);
    fireEvent.click(await screen.findByRole("option"));
    const button = await screen.findByRole("button", { name: "Reveal in file manager" });

    fireEvent.click(button);
    fireEvent.click(button);
    second.reject(new Error("EACCES /private/tmp/LATEST-ZIPKIT-REVEAL"));
    first.resolve();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("archive could not be revealed");
    expect(alert.textContent).not.toContain("LATEST-ZIPKIT-REVEAL");
  });
});
