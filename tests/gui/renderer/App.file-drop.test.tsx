// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../../src/gui/renderer/src/App";
import { DialogHost } from "../../../src/gui/renderer/src/components/DialogHost";
import type { Job } from "../../../src/gui/shared/api";
import { DEFAULT_LAYOUT } from "../../../src/gui/shared/layout";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec";

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

function fileEvent(type: "dragover" | "dragleave" | "drop", files: File[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: ["Files"],
      items: files.length > 0
        ? files.map((file) => ({ kind: "file", getAsFile: () => file }))
        : [],
      files,
      dropEffect: "none",
    },
  });
  return event;
}

describe("App file-drop receivers", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  const addJob = vi.fn(async () => "job-from-drop");
  const chooseInputs = vi.fn<() => Promise<string[]>>();
  const getQueue = vi.fn<() => Promise<Job[]>>();
  const updateJob = vi.fn(async () => {});

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    addJob.mockReset().mockResolvedValue("job-from-drop");
    chooseInputs.mockReset().mockResolvedValue([]);
    getQueue.mockReset().mockResolvedValue([]);
    updateJob.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(window, "zipkit", {
      configurable: true,
      value: {
        onQueue: () => () => {},
        getQueue,
        getSettings: async () => ({ defaults: DEFAULT_OPTIONS, uiFontFamily: "" }),
        getLayout: async () => DEFAULT_LAYOUT,
        getPlan: async () => null,
        onEvent: () => () => {},
        pathForFile: () => "/tmp/ZIPKIT-DRAG-ME",
        chooseInputs,
        addJob,
        updateJob,
        reportError: vi.fn(),
      },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container.remove();
    vi.unstubAllGlobals();
  });

  it("creates a job only when the file is dropped on Jobs", async () => {
    await act(async () => {
      root?.render(
        <DialogHost>
          <App />
        </DialogHost>,
      );
    });
    const shell = container.firstElementChild!;
    const jobs = container.querySelector<HTMLElement>('[data-drop-receiver="jobs"]')!;
    expect(jobs.querySelector("h2")).toBeNull();
    expect(jobs.closest("section")?.querySelector("h2")?.textContent).toBe("Jobs");

    const over = fileEvent("dragover", []);
    await act(async () => jobs.dispatchEvent(over));
    expect(over.defaultPrevented).toBe(true);
    expect((over as Event & { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect).toBe("copy");
    expect(jobs.style.boxShadow).toContain("var(--accent)");
    expect(container.textContent).not.toContain("Drop to check files and folders");
    await act(async () => jobs.dispatchEvent(fileEvent("dragleave", [])));
    expect(jobs.style.boxShadow).toBe("");
    await act(async () => jobs.dispatchEvent(fileEvent("dragover", [])));

    const folder = new File([], "ZIPKIT-DRAG-ME");
    const drop = fileEvent("drop", [folder]);
    await act(async () => jobs.dispatchEvent(drop));

    expect(addJob).toHaveBeenCalledWith(["/tmp/ZIPKIT-DRAG-ME"], DEFAULT_OPTIONS, "save");
    expect(jobs.style.boxShadow).toBe("");

    addJob.mockClear();
    const deadSpaceDrop = fileEvent("drop", [folder]);
    await act(async () => shell.dispatchEvent(deadSpaceDrop));
    expect(deadSpaceDrop.defaultPrevented).toBe(true);
    expect(addJob).not.toHaveBeenCalled();
  });

  it("adds a dropped file to the selected job only when it lands on Inputs", async () => {
    getQueue.mockResolvedValue([{
      id: "job-1",
      inputs: ["/tmp/existing.txt"],
      entries: [{ path: "/tmp/existing.txt", kind: "file" }],
      options: DEFAULT_OPTIONS,
      intent: "save",
      state: "ready",
    }]);
    await act(async () => {
      root?.render(
        <DialogHost>
          <App />
        </DialogHost>,
      );
    });

    const job = container.querySelector<HTMLElement>('[data-job-id="job-1"]')!;
    await act(async () => job.click());
    const inputs = container.querySelector<HTMLElement>('[data-drop-receiver="inputs"]')!;
    expect(inputs).not.toBeNull();

    const dropped = new File([], "ZIPKIT-DRAG-ME");
    await act(async () => inputs.dispatchEvent(fileEvent("drop", [dropped])));

    expect(updateJob).toHaveBeenCalledWith("job-1", {
      inputs: ["/tmp/existing.txt", "/tmp/ZIPKIT-DRAG-ME"],
    });
    expect(addJob).not.toHaveBeenCalled();
  });

  it("keeps an unresolved Jobs result through an unrelated successful drop", async () => {
    addJob.mockRejectedValueOnce(new Error("first input failed"));
    await act(async () => {
      root?.render(
        <DialogHost>
          <App />
        </DialogHost>,
      );
    });
    const jobs = container.querySelector<HTMLElement>('[data-drop-receiver="jobs"]')!;

    await act(async () => jobs.dispatchEvent(fileEvent("drop", [
      new File([], "first.txt", { lastModified: 41 }),
    ])));
    const alert = container.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toContain("first input failed");
    expect(alert.classList.contains("receiver-result--error")).toBe(true);

    await act(async () => jobs.dispatchEvent(fileEvent("drop", [
      new File([], "other.txt", { lastModified: 42 }),
    ])));
    expect(addJob).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLElement>('[role="alert"]')?.textContent)
      .toContain("first input failed");
  });

  it("renders a failed job creation as an error rather than information", async () => {
    addJob.mockRejectedValueOnce(new Error("queue unavailable"));
    await act(async () => {
      root?.render(
        <DialogHost>
          <App />
        </DialogHost>,
      );
    });
    const jobs = container.querySelector<HTMLElement>('[data-drop-receiver="jobs"]')!;
    const input = new File([], "new.txt", { lastModified: 42 });
    await act(async () => jobs.dispatchEvent(fileEvent("drop", [input])));

    const alert = container.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toContain("Could not create the job");
    expect(alert.classList.contains("receiver-result--error")).toBe(true);
  });

  it("clears a failed creation result when the same dropped input succeeds on retry", async () => {
    addJob.mockRejectedValueOnce(new Error("queue unavailable"));
    await act(async () => {
      root?.render(
        <DialogHost>
          <App />
        </DialogHost>,
      );
    });
    const jobs = container.querySelector<HTMLElement>('[data-drop-receiver="jobs"]')!;
    const input = new File([], "new.txt", { lastModified: 42 });
    await act(async () => jobs.dispatchEvent(fileEvent("drop", [input])));
    expect(container.querySelector<HTMLElement>('[role="alert"]')?.textContent)
      .toContain("Could not create the job");

    await act(async () => jobs.dispatchEvent(fileEvent("drop", [input])));

    expect(addJob).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("clears a picker-boundary failure when the picker next succeeds", async () => {
    chooseInputs
      .mockRejectedValueOnce(new Error("picker unavailable"))
      .mockResolvedValueOnce(["/tmp/new.txt"]);
    await act(async () => {
      root?.render(
        <DialogHost>
          <App />
        </DialogHost>,
      );
    });
    const add = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Add")!;

    await act(async () => {
      add.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(chooseInputs).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLElement>('[role="alert"]')?.textContent)
      .toContain("picker unavailable");

    await act(async () => {
      add.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(addJob).toHaveBeenCalledWith(["/tmp/new.txt"], DEFAULT_OPTIONS, "save");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
