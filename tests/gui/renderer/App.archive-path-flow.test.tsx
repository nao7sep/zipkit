// @vitest-environment jsdom
/** The selected folder must survive the job editor, parameter reset, pane
 * reopening and queue restore, then become the real SDK plan's destination.
 * Only native selection and the window transport are substituted. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../../src/gui/renderer/src/App";
import { DialogHost } from "../../../src/gui/renderer/src/components/DialogHost";
import { createQueueEngine, type QueueEngine } from "../../../src/gui/main/queue-engine";
import { CommandAdmission } from "../../../src/gui/main/command-admission";
import { createSdk } from "../../../src/gui/main/sdk";
import { loadQueue, saveQueue, toResumable } from "../../../src/gui/main/persist";
import { closeBackupStore } from "../../../src/gui/main/backupStore";
import { nullLog } from "../../../src/gui/main/log";
import { DEFAULT_LAYOUT } from "../../../src/gui/shared/layout";
import { DEFAULT_OPTIONS, DEFAULT_SETTINGS } from "../../../src/gui/shared/spec";
import { toPlanReport } from "../../../src/gui/shared/plan-report";
import type { Job } from "../../../src/gui/shared/queue";
import { eventuallyRendered } from "../../helpers/eventually.js";

let root: string | undefined;
const engines: QueueEngine[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(engines.splice(0).map((engine) => engine.shutdown()));
  await closeBackupStore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

it("plans the picked folder with the edited name after parameter reset and job restore", async () => {
  root = await mkdtemp(path.join(tmpdir(), "zipkit-path-flow-"));
  vi.stubEnv("ZIPKIT_DATA_DIR", path.join(root, "app-data"));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const source = path.join(root, "source");
  const selected = path.join(root, "Chosen output");
  await mkdir(source);
  await mkdir(selected);
  const inputs = [path.join(source, "one.txt"), path.join(source, "two.txt")];
  await Promise.all(inputs.map((input) => writeFile(input, "contents")));
  const sdk = createSdk();
  let pushQueue = (_jobs: Job[]): void => {};
  let nextId = 0;
  const unexpected = async (): Promise<never> => { throw new Error("This flow only plans archives"); };
  const makeEngine = (): QueueEngine => {
    const engine = createQueueEngine({
      admission: new CommandAdmission(),
      pathState: (target, signal) => sdk.pathState(target, { signal }),
      pathKinds: (paths) => sdk.pathKinds(paths),
      plan: (paths, options, signal, onEvent) => sdk.plan(paths, options, { signal, onEvent }),
      write: unexpected, verify: unexpected, inspect: unexpected,
      checkRemoval: unexpected, trash: unexpected, deleteOriginals: unexpected,
      emit: (jobs) => pushQueue(structuredClone(jobs)), progress: () => () => {},
      newId: () => `job-${++nextId}`, log: nullLog,
    });
    engines.push(engine);
    return engine;
  };
  let engine = makeEngine();
  const id = engine.add(inputs, { ...DEFAULT_OPTIONS, level: 3 });
  const other = engine.add([inputs[0]!], DEFAULT_OPTIONS);
  await eventuallyRendered(() => expect(engine.snapshot().every((job) => job.state === "ready")).toBe(true));
  const chooseOutputDir = vi.fn(async () => selected);
  const reportError = vi.fn();
  Object.defineProperty(window, "zipkit", { configurable: true, value: {
    onQueue: (listener: typeof pushQueue) => {
      pushQueue = listener;
      listener(structuredClone(engine.snapshot()));
      return () => { pushQueue = () => {}; };
    },
    updateJob: async (jobId: string, patch: Parameters<QueueEngine["update"]>[1]) => engine.update(jobId, patch),
    getPlan: async (jobId: string) => { const plan = engine.getPlan(jobId); return plan ? toPlanReport(plan) : null; },
    refreshJob: (jobId: string) => engine.refresh(jobId),
    getSettings: async () => DEFAULT_SETTINGS, getLayout: async () => DEFAULT_LAYOUT,
    onQueueSaved: () => () => {}, onSettingsChanged: () => () => {},
    onOpenAbout: () => () => {}, getJobEvents: async () => [],
    onEvents: () => () => {}, onProgress: () => () => {},
    chooseOutputDir, reportError,
  } });
  const show = () => render(<DialogHost><App /></DialogHost>);
  let view = show();
  const open = async (jobId: string) => {
    await eventuallyRendered(() => expect(view.container.querySelector(`[data-job-id="${jobId}"]`)).toBeTruthy());
    await act(async () => { fireEvent.click(view.container.querySelector(`[data-job-id="${jobId}"]`)!); });
  };
  await open(id);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Choose" })); });
  expect(chooseOutputDir).toHaveBeenCalledExactlyOnceWith("", inputs, "");
  fireEvent.change(screen.getByRole("textbox", { name: "File name" }), { target: { value: "Client delivery.zip" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Use the parameters from Settings" }));
  expect(engine.snapshot().find((job) => job.id === id)?.options).toMatchObject({
    outputDir: selected, fileName: "Client delivery.zip", level: DEFAULT_SETTINGS.defaults.level,
  });
  await open(other);
  await open(id);
  expect((screen.getByRole("textbox", { name: /^Output directory/ }) as HTMLInputElement).value).toBe(selected);
  expect((screen.getByRole("textbox", { name: "File name" }) as HTMLInputElement).value).toBe("Client delivery.zip");

  // Save while the edited plan may still be debounced, as an immediate quit does.
  view.unmount();
  await saveQueue(toResumable(engine.snapshot()));
  await engine.shutdown();
  engine = makeEngine();
  engine.restore((await loadQueue()).value.jobs);
  await eventuallyRendered(() => expect(engine.snapshot().every((job) => job.state === "ready")).toBe(true));
  view = show();
  await open(id);
  expect((screen.getByRole("textbox", { name: /^Output directory/ }) as HTMLInputElement).value).toBe(selected);
  expect((screen.getByRole("textbox", { name: "File name" }) as HTMLInputElement).value).toBe("Client delivery.zip");
  expect((screen.getByRole("checkbox", { name: "Use the parameters from Settings" }) as HTMLInputElement).checked).toBe(true);
  const plan = engine.getPlan(id)!;
  expect(plan.writable).toBe(true);
  expect(plan.output).toBe(path.join(selected, "Client delivery.zip"));
  expect(plan.instructions.output).toBe(plan.output);
  expect(engine.snapshot().find((job) => job.id === id)?.output).toBe(plan.output);
  expect(reportError).not.toHaveBeenCalled();
});
