// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { App } from "../../../src/gui/renderer/src/App";
import { DialogHost } from "../../../src/gui/renderer/src/components/DialogHost";
import { createQueueEngine, type EngineDeps } from "../../../src/gui/main/queue-engine.js";
import { createArchiveEffects } from "../../../src/gui/main/archive-effects.js";
import { CommandAdmission } from "../../../src/gui/main/command-admission.js";
import { nullLog } from "../../../src/gui/main/log.js";
import type { Job, JobIntent, PlanData, ZipKitGuiApi } from "../../../src/gui/shared/api";
import { DEFAULT_LAYOUT } from "../../../src/gui/shared/layout";
import { DEFAULT_OPTIONS, DEFAULT_SETTINGS } from "../../../src/gui/shared/spec";
import { SAVE, TRASH } from "../../helpers/intents.js";
import { SAFEST_INTENT } from "../../../src/gui/shared/queue.js";

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

const job = (id: string): Job => ({
  id,
  inputs: [`/${id}`],
  options: DEFAULT_OPTIONS,
  intent: SAVE,
  state: "ready",
});

function api(overrides: Partial<ZipKitGuiApi> = {}): ZipKitGuiApi {
  return {
    chooseInputs: vi.fn(async () => []),
    chooseOutputDir: vi.fn(async () => ""),
    pathForFile: vi.fn(() => ""),
    platform: "darwin",
    onWindowActivityChanged: vi.fn(() => () => {}),
    onSettingsChanged: vi.fn(() => () => {}),
    onOpenAbout: vi.fn(() => () => {}),
    getSettings: vi.fn(async () => ({ defaults: DEFAULT_OPTIONS, uiFontFamily: "", theme: "system" as const, language: "system" as const, timeZone: "system" })),
    getLanguageEnvironment: vi.fn(async () => ({ language: "en" as const, locale: "en", timeZone: null })),
    onLanguageChanged: vi.fn(() => () => {}),
    getSystemChoices: vi.fn(async () => ({ appearance: "light" as const, language: "en" as const, timeZone: "UTC" })),
    discardSettingsSubmission: vi.fn(async () => {}),
    reportSettingsDraft: vi.fn(),
    setSettings: vi.fn(async () => DEFAULT_SETTINGS),
    getLayout: vi.fn(async () => DEFAULT_LAYOUT),
    setLayout: vi.fn(async () => {}),
    addJob: vi.fn(async () => "new"),
    updateJob: vi.fn(async () => {}),
    addJobInputs: vi.fn(async (_id, paths) => ({ accepted: paths, duplicates: 0 })),
    removeJobInput: vi.fn(async () => {}),
    removeJob: vi.fn(async () => {}),
    runJob: vi.fn(async () => {}),
    removeArchive: vi.fn(async () => {}),
    trashOriginals: vi.fn(async () => {}),
    deleteOriginals: vi.fn(async () => {}),
    cancelJob: vi.fn(async () => {}),
    getPlan: vi.fn(async () => null),
    getQueue: vi.fn(async () => []),
    onQueue: vi.fn(() => () => {}),
    onQueueSaved: vi.fn(() => () => {}),
    verify: vi.fn(),
    refreshJob: vi.fn(async () => {}),
    reveal: vi.fn(),
    getJobEvents: vi.fn(async () => []),
    onEvents: vi.fn(() => () => {}),
    openRecordsWindow: vi.fn(async () => {}),
    readRecordsPage: vi.fn(async () => ({ records: [], more: false })),
    readRecordDetail: vi.fn(async () => null),
    readRecordSources: vi.fn(async () => ({ currentSession: "", sessions: [] })),
    getRecordsListWidth: vi.fn(async () => 380),
    saveRecordsListWidth: vi.fn(async (width: number) => width),
    onRecordsChanged: vi.fn(() => () => {}),
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

describe("queue save result", () => {
  it("shows a failed queue save until a later save succeeds", async () => {
    let publish: ((saved: boolean) => void) | undefined;
    const bridge = api({
      onQueueSaved: vi.fn((callback) => {
        publish = callback;
        return () => {};
      }),
    });

    renderApp(bridge);
    await screen.findByRole("heading", { name: "Jobs" });

    act(() => publish?.(false));
    expect(await screen.findByText(/The queue wasn’t saved/)).toBeTruthy();

    act(() => publish?.(true));
    await waitFor(() => expect(screen.queryByText(/The queue wasn’t saved/)).toBeNull());
  });
});

describe("required app hydration", () => {
  it("blocks the ordinary interface after a failed load and retries the complete hydration", async () => {
    const getSettings = vi
      .fn<ZipKitGuiApi["getSettings"]>()
      .mockRejectedValueOnce(new Error("settings unavailable"))
      .mockResolvedValueOnce({ defaults: DEFAULT_OPTIONS, uiFontFamily: "", theme: "system", language: "system", timeZone: "system" });
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
  it("records a failed layout save, shows nothing, and keeps the layout in use", async () => {
    const setLayout = vi.fn<ZipKitGuiApi["setLayout"]>().mockRejectedValue(new Error("disk full"));
    const bridge = api({ setLayout });
    renderApp(bridge);
    const splitter = await screen.findByRole("separator", { name: "Resize Jobs pane" });

    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    fireEvent.keyUp(splitter, { key: "ArrowRight" });

    await waitFor(() => expect(bridge.reportError).toHaveBeenCalledWith("persist pane layout", expect.objectContaining({ message: "disk full" })));
    expect(screen.queryByRole("alert")).toBeNull();
    const width = Number(splitter.getAttribute("aria-valuenow"));
    expect(width).toBeGreaterThan(DEFAULT_LAYOUT.jobsWidth);
    expect(setLayout).toHaveBeenCalledWith({ ...DEFAULT_LAYOUT, jobsWidth: width });
  });

  it("saves a keyboard resize once on release, and each release without waiting for the previous save", async () => {
    const setLayout = vi.fn<ZipKitGuiApi["setLayout"]>().mockReturnValue(new Promise<void>(() => {}));
    renderApp(api({ setLayout }));
    const splitter = await screen.findByRole("separator", { name: "Resize Jobs pane" });

    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    fireEvent.keyDown(splitter, { key: "ArrowRight", repeat: true });
    expect(setLayout).not.toHaveBeenCalled();
    fireEvent.keyUp(splitter, { key: "ArrowRight" });
    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    fireEvent.keyUp(splitter, { key: "ArrowRight" });

    // Main writes them in the order they arrive (layout.ts), so the newest is what stays on disk.
    const widths = setLayout.mock.calls.map(([layout]) => layout.jobsWidth);
    expect(widths).toEqual([DEFAULT_LAYOUT.jobsWidth + 32, DEFAULT_LAYOUT.jobsWidth + 48]);
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
    expect(alert.textContent).toContain("Archive creation could not start");
    expect(alert.textContent).not.toContain("ZIPKIT_RUN_SENTINEL");
    expect(bridge.reportError).toHaveBeenCalledWith("run job", expect.objectContaining({ message: expect.stringContaining("ZIPKIT_RUN_SENTINEL") }));
  });

  it("keeps the previous intent and retains authored copy when the mutation rejects", async () => {
    const updateJob = vi.fn<ZipKitGuiApi["updateJob"]>().mockRejectedValue(new Error("EACCES /private/tmp/ZIPKIT_INTENT_SENTINEL"));
    const bridge = api({ getQueue: vi.fn(async () => [job("intent-job")]), updateJob });
    renderApp(bridge);
    fireEvent.click(await screen.findByRole("option"));
    fireEvent.click(await screen.findByRole("radio", { name: "Delete permanently" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("previous choice is still selected");
    expect(alert.textContent).not.toContain("ZIPKIT_INTENT_SENTINEL");
    expect((screen.getByRole("radio", { name: "Keep" }) as HTMLInputElement).checked).toBe(true);
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

describe("the Records menu item", () => {
  async function chooseRecords(): Promise<void> {
    const trigger = await screen.findByRole("button", { name: "Menu" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Records" }));
  }

  it("opens the Records window from the header menu, between Settings and Shortcut keys", async () => {
    const bridge = api({ getQueue: vi.fn(async () => [job("a")]) });
    renderApp(bridge);
    const trigger = await screen.findByRole("button", { name: "Menu" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    expect(items).toEqual(["Settings", "Records", "Shortcut keys", "About ZipKit"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Records" }));
    expect(bridge.openRecordsWindow).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when the Records window could not be opened, until dismissed or opened", async () => {
    const openRecordsWindow = vi
      .fn<ZipKitGuiApi["openRecordsWindow"]>()
      .mockRejectedValueOnce(new Error("no page"))
      .mockResolvedValueOnce(undefined);
    const bridge = api({ openRecordsWindow });
    renderApp(bridge);

    await chooseRecords();
    expect((await screen.findByRole("alert")).textContent).toContain("The records window could not be opened.");
    expect(bridge.reportError).toHaveBeenCalledWith("open the Records window", expect.objectContaining({ message: "no page" }));

    await chooseRecords();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("mounted run consent across queue projection changes", () => {
  const original = "/sources/original.txt";
  const added = "/sources/later.txt";

  function ownedQueue(intent: JobIntent, { withholdIntentProjection = true } = {}) {
    let publish: ((jobs: Job[]) => void) | undefined;
    let withholdProjection = false;
    const deps: EngineDeps = {
      admission: new CommandAdmission(),
      effects: createArchiveEffects(),
      resources: vi.fn(async (paths: string[]) => paths.map((location) => ({ location, identity: location }))),
      plan: vi.fn(async (): Promise<PlanData> => ({
        mode: "plan",
        output: "/out/consent.zip",
        log: "",
        writable: true,
        summary: { total: 1, included: 1, excluded: 0, renamed: 0, warnings: 0, errors: 0, zip64: false },
        findings: [],
        entries: [],
      })),
      write: vi.fn(async () => 123),
      verify: vi.fn(async () => true),
      recheck: vi.fn(async () => ({ matches: true, added: [], missing: [], changed: [], unlisted: [] })),
      classify: vi.fn(async (paths: string[]) => paths.map((path) => ({ path, kind: "file" as const }))),
      trash: vi.fn(async (paths) => ({ moved: paths, failed: [], unconfirmed: [] })),
      deleteOriginals: vi.fn(async (paths: string[]) => ({ moved: paths, failed: [], unconfirmed: [] })),
      outputInsideInputs: vi.fn(async () => false),
      pathState: vi.fn(async (target: string) => ({ kind: "present" as const, fingerprint: `1:${target}:1:1` })),
      inspect: vi.fn(async () => ({ reportOk: true, summary: { total: 1, crcFailed: 0, shaMismatched: 0, manifestMismatched: 0 } as never, missing: [], extra: [] })),
      emit: vi.fn((jobs) => { if (!withholdProjection) publish?.(jobs); }),
      progress: vi.fn(() => vi.fn()),
      newId: vi.fn(() => "consent-job"),
      log: nullLog,
    };
    const engine = createQueueEngine(deps);
    const bridge = api({
      getQueue: vi.fn(async () => engine.snapshot()),
      getPlan: vi.fn(async (id) => engine.getPlan(id)),
      onQueue: vi.fn((callback) => {
        publish = callback;
        return () => { if (publish === callback) publish = undefined; };
      }),
      updateJob: vi.fn(async (id, patch) => {
        // Main has accepted the intent before its pushed projection reaches the window.
        if (patch.intent !== undefined && withholdIntentProjection) withholdProjection = true;
        engine.update(id, patch);
      }),
      addJobInputs: vi.fn(async (id, paths) => engine.addInputs(id, paths)),
      runJob: vi.fn(async (id, scope) => engine.run(id, scope)),
    });
    const id = engine.add([original], DEFAULT_OPTIONS, intent);
    return { engine, deps, bridge, id };
  }

  it("captures comment, filename and output-folder keystrokes before an immediate quit or window close", async () => {
    const { engine, deps, bridge, id } = ownedQueue(SAVE);
    let mounted: ReturnType<typeof renderApp> | undefined;
    try {
      await waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      mounted = renderApp(bridge);
      fireEvent.click(await screen.findByRole("option"));
      // The job's own fields are editable while it uses the Settings' parameters,
      // and editing them leaves it on the defaults.
      const useDefaults = await screen.findByRole("checkbox", { name: "Use the parameters from Settings" });
      fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "last keystroke" } });
      fireEvent.change(screen.getByRole("textbox", { name: "File name" }), { target: { value: "last-name" } });
      fireEvent.change(screen.getByRole("textbox", { name: /Output directory/ }), { target: { value: "/last-folder" } });
      expect((useDefaults as HTMLInputElement).checked).toBe(true);
      // No blur, navigation, renderer timer or planning wait is required.
      const held = engine.snapshot()[0]!;
      expect(held.options).toMatchObject({ comment: "last keystroke", fileName: "last-name", outputDir: "/last-folder" });
      expect(bridge.updateJob).toHaveBeenCalledTimes(3);
      await engine.shutdown();
      mounted.unmount(); mounted = undefined;
      expect(engine.snapshot()[0]?.options).toEqual(held.options);
      expect(deps.plan).toHaveBeenCalledOnce(); // Quit retires deferred scanning only.
      expect(bridge.updateJob).toHaveBeenCalledTimes(3);
      expect(engine.snapshot()[0]?.id).toBe(id);
    } finally { mounted?.unmount(); await engine.shutdown(); }
  });

  it("restores only the parameters when Use the parameters from Settings is ticked again", async () => {
    const { engine, bridge } = ownedQueue(SAVE);
    let mounted: ReturnType<typeof renderApp> | undefined;
    try {
      await waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      mounted = renderApp(bridge);
      fireEvent.click(await screen.findByRole("option"));
      fireEvent.change(screen.getByRole("textbox", { name: "File name" }), { target: { value: "delivery" } });
      const useDefaults = screen.getByRole("checkbox", { name: "Use the parameters from Settings" });
      fireEvent.click(useDefaults);
      fireEvent.click(screen.getByRole("checkbox", { name: /Drop OS junk files/ }));
      expect(engine.snapshot()[0]?.options).toMatchObject({ junk: false, fileName: "delivery" });
      fireEvent.click(useDefaults);
      expect(engine.snapshot()[0]?.options).toEqual({ ...DEFAULT_OPTIONS, fileName: "delivery" });
    } finally { mounted?.unmount(); await engine.shutdown(); }
  });

  it.each([
    { trigger: "Create button", context: "run job" },
    { trigger: "Cmd+Enter", context: "run selected job" },
  ])("rejects the old save scope from $trigger after main accepts a destructive intent", async ({ trigger, context }) => {
    const { engine, deps, bridge, id } = ownedQueue(SAVE);
    let mounted: ReturnType<typeof renderApp> | undefined;
    try {
      await waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      mounted = renderApp(bridge);
      fireEvent.click(await screen.findByRole("option"));
      fireEvent.click(await screen.findByRole("radio", { name: "Move to Trash" }));
      const destructive = { ...SAVE, originals: "trash" as const };
      await waitFor(() => expect(bridge.updateJob).toHaveBeenCalledWith(id, { intent: destructive }));
      expect(engine.snapshot()[0]?.intent).toEqual(destructive);
      expect((screen.getByRole("radio", { name: "Keep" }) as HTMLInputElement).checked).toBe(true);

      if (trigger === "Create button") fireEvent.click(screen.getByRole("button", { name: "Create archive" }));
      else fireEvent.keyDown(window, { key: "Enter", metaKey: true });

      const alert = await screen.findByRole("alert");
      expect(bridge.runJob).toHaveBeenCalledExactlyOnceWith(id, { intent: SAVE, inputs: [original] });
      expect(alert.textContent).toContain("Archive creation could not start. The job is unchanged; try again.");
      expect(alert.textContent).not.toContain("The job changed since this action was confirmed");
      expect(bridge.reportError).toHaveBeenCalledWith(context, expect.objectContaining({ message: "The job changed since this action was confirmed" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(deps.write).not.toHaveBeenCalled();
      expect(deps.trash).not.toHaveBeenCalled();
    } finally {
      mounted?.unmount();
      await engine.shutdown();
    }
  });

  it("rejects the captured destructive scope when an in-flight input picker adds a source during confirmation", async () => {
    const { engine, deps, bridge, id } = ownedQueue(TRASH);
    let releasePicker!: (paths: string[]) => void;
    vi.mocked(bridge.chooseInputs).mockReturnValueOnce(new Promise<string[]>((resolve) => { releasePicker = resolve; }));
    let mounted: ReturnType<typeof renderApp> | undefined;
    try {
      await waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      mounted = renderApp(bridge);
      fireEvent.click(await screen.findByRole("option"));
      fireEvent.click(within(screen.getByText("Inputs").parentElement!).getByRole("button", { name: "Add" }));
      expect(bridge.chooseInputs).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: "Create archive" }));
      const dialog = await screen.findByRole("dialog", { name: "Create archive and move originals to Trash?" });
      expect(dialog.textContent).toContain("the 1 original item will be moved");
      expect(bridge.runJob).not.toHaveBeenCalled();

      await act(async () => releasePicker([added]));
      await waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      expect(bridge.addJobInputs).toHaveBeenCalledExactlyOnceWith(id, [added]);
      expect(engine.snapshot()[0]?.inputs).toEqual([original, added]);
      expect(dialog.textContent).toContain("the 1 original item will be moved");
      fireEvent.click(within(dialog).getByRole("button", { name: "Create and move to Trash" }));

      const alert = await screen.findByRole("alert");
      expect(bridge.runJob).toHaveBeenCalledExactlyOnceWith(id, { intent: TRASH, inputs: [original] });
      expect(alert.textContent).toContain("Archive creation could not start. The job is unchanged; try again.");
      expect(alert.textContent).not.toContain("The job changed since this action was confirmed");
      expect(bridge.reportError).toHaveBeenCalledWith("run job", expect.objectContaining({ message: "The job changed since this action was confirmed" }));
      expect(deps.write).not.toHaveBeenCalled();
      expect(deps.trash).not.toHaveBeenCalled();
    } finally {
      releasePicker([]);
      mounted?.unmount();
      await engine.shutdown();
    }
  });

  it("verifies by default, locks verification on when the originals are deleted, and asks before deleting them for good", async () => {
    const { engine, deps, bridge, id } = ownedQueue(SAFEST_INTENT, { withholdIntentProjection: false });
    let mounted: ReturnType<typeof renderApp> | undefined;
    try {
      await waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      mounted = renderApp(bridge);
      fireEvent.click(await screen.findByRole("option"));
      const verify = await screen.findByRole("checkbox", { name: "Verify the archive after creating it" }) as HTMLInputElement;
      expect(verify.checked).toBe(true);
      expect(verify.disabled).toBe(false);
      expect((screen.getByRole("radio", { name: "Keep" }) as HTMLInputElement).checked).toBe(true);

      fireEvent.click(screen.getByRole("radio", { name: "Delete permanently" }));
      await waitFor(() => expect(engine.snapshot()[0]?.intent).toEqual({ verify: true, originals: "delete" }));
      await waitFor(() => expect(verify.disabled).toBe(true));
      expect(verify.checked).toBe(true);
      expect(screen.getByText("Removing the originals always verifies the archive first.")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Create archive" }));
      const dialog = await screen.findByRole("dialog", { name: "Create archive and delete originals permanently?" });
      expect(dialog.textContent).toContain("can’t be undone");
      fireEvent.click(within(dialog).getByRole("button", { name: "Create and delete permanently" }));
      await waitFor(() => expect(engine.snapshot()[0]?.state).toBe("done"));
      expect(bridge.runJob).toHaveBeenCalledWith(id, { intent: { verify: true, originals: "delete" }, inputs: [original] });
      expect(deps.deleteOriginals).toHaveBeenCalledWith([original], expect.any(AbortSignal));
      expect(deps.trash).not.toHaveBeenCalled();
    } finally {
      mounted?.unmount();
      await engine.shutdown();
    }
  });
});

describe("the Archive pane layout", () => {
  it("leads with the control panel and closes with the inputs, folder before file name", async () => {
    renderApp(api({ getQueue: vi.fn(async () => [job("a")]) }));
    fireEvent.click(await screen.findByRole("option"));
    const order = [
      screen.getByRole("textbox", { name: /Output directory/ }),
      screen.getByRole("textbox", { name: "File name" }),
      screen.getByRole("checkbox", { name: /Overwrite/ }),
      screen.getByRole("radiogroup"),
      screen.getByRole("button", { name: /Parameters/ }),
      screen.getByRole("textbox", { name: "Comment" }),
      screen.getByText("Inputs"),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("folds the parameters while the job uses the Settings' ones, unfolds them on request, and unticking unfolds them", async () => {
    renderApp(api({ getQueue: vi.fn(async () => [job("a")]) }));
    fireEvent.click(await screen.findByRole("option"));
    const fold = screen.getByRole("button", { name: /Parameters/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("checkbox", { name: /Drop OS junk files/ })).toBeNull();
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("checkbox", { name: /Drop OS junk files/ })).toBeTruthy();
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    // Unticking is for editing, so the parameters open with it.
    fireEvent.click(screen.getByRole("checkbox", { name: "Use the parameters from Settings" }));
    expect(fold.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("a finished job's history and archive", () => {
  it("lists what happened under the commands and looks at the archive again on selection and on focus", async () => {
    const finished: Job = {
      ...job("a"),
      state: "done",
      archiveWritten: true,
      archiveStatus: "verified",
      history: [
        { at: 1, severity: "info", message: { key: "job.savedVerified", values: { count: 10 } } },
        { at: 2, severity: "warning", message: { key: "report.archiveChanged" } },
      ],
    };
    const bridge = api({ getQueue: vi.fn(async () => [finished]) });
    renderApp(bridge);
    fireEvent.click(await screen.findByRole("option"));
    const history = screen.getByRole("list", { name: "History" });
    expect(within(history).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Saved and verified (10 bytes).",
      "The archive has changed since ZipKit last checked it. Verify it again.",
    ]);
    // A verified archive offers no second Verify.
    expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
    await waitFor(() => expect(bridge.refreshJob).toHaveBeenCalledWith("a"));
    const before = vi.mocked(bridge.refreshJob).mock.calls.length;
    fireEvent.focus(window);
    expect(vi.mocked(bridge.refreshJob).mock.calls.length).toBe(before + 1);
  });
});
