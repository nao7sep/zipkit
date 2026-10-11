// @vitest-environment jsdom

/**
 * When a job's option edits reach the engine. A finished change (a box, a choice)
 * is sent at once; typing waits 250 ms after the last keystroke. That wait outlives
 * the edit: a job that finishes inside it no longer accepts the change, so the pane
 * must not keep showing a value the job never took, and selecting another job must
 * send what is still waiting rather than drop it.
 */

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

// Options that differ from the defaults, so the pane's "Use default parameters" is
// off and the parameter controls are live.
const CUSTOM_OPTIONS = { ...DEFAULT_OPTIONS, level: 3 };

const readyJob: Job = {
  id: "job-1",
  inputs: ["/tmp/thing.txt"],
  entries: [{ path: "/tmp/thing.txt", kind: "file" }],
  options: CUSTOM_OPTIONS,
  intent: "save",
  state: "ready",
};
const otherJob: Job = { ...readyJob, id: "job-2", inputs: ["/tmp/other.txt"], entries: [{ path: "/tmp/other.txt", kind: "file" }] };

/** Type into a React-controlled textarea the way a keystroke does, without leaving it. */
function typeInto(field: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("a job that finishes mid-edit", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  const updateJob = vi.fn(async () => {});
  let pushQueue: (jobs: Job[]) => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    updateJob.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(window, "zipkit", {
      configurable: true,
      value: {
        onQueue: (listener: (jobs: Job[]) => void) => {
          pushQueue = listener;
          return () => {};
        },
        onQueueSaved: () => () => {},
        getQueue: async () => [readyJob, otherJob],
        onSettingsChanged: vi.fn(() => () => {}),
        getSettings: async () => ({ defaults: DEFAULT_OPTIONS, uiFontFamily: "" }),
        getLayout: async () => DEFAULT_LAYOUT,
        getPlan: async () => null,
        getJobEvents: async () => [],
        onEvent: () => () => {},
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
    vi.useRealTimers();
  });

  async function openJob(id: string): Promise<void> {
    const row = container.querySelector<HTMLElement>(`[data-job-id="${id}"]`)!;
    await act(async () => row.click());
  }

  async function renderApp(): Promise<void> {
    await act(async () => {
      root?.render(
        <DialogHost>
          <App />
        </DialogHost>,
      );
    });
  }

  const junk = (): HTMLInputElement => {
    const label = [...container.querySelectorAll("label")]
      .find((node) => node.textContent?.includes("Drop OS junk files"))!;
    return label.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  };
  const comment = (): HTMLTextAreaElement => container.querySelector("textarea")!;

  it("sends a checkbox change at once", async () => {
    await renderApp();
    await openJob("job-1");

    expect(junk().checked).toBe(true);
    await act(async () => junk().click());

    expect(updateJob).toHaveBeenCalledWith("job-1", { options: { ...CUSTOM_OPTIONS, junk: false } });
  });

  it("drops the pending typed change and shows the options the job kept", async () => {
    await renderApp();
    await openJob("job-1");

    await act(async () => typeInto(comment(), "late words"));
    expect(comment().value).toBe("late words");

    // The job runs and finishes inside the typing delay.
    await act(async () => pushQueue([{ ...readyJob, state: "done", output: "/tmp/thing.zip" }, otherJob]));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(updateJob).not.toHaveBeenCalled();
    expect(comment().value).toBe(CUSTOM_OPTIONS.comment);
  });

  it("sends typing still waiting when another job is selected", async () => {
    await renderApp();
    await openJob("job-1");

    await act(async () => typeInto(comment(), "for the client"));
    expect(updateJob).not.toHaveBeenCalled();
    await openJob("job-2");

    expect(updateJob).toHaveBeenCalledTimes(1);
    expect(updateJob).toHaveBeenCalledWith("job-1", { options: { ...CUSTOM_OPTIONS, comment: "for the client" } });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(updateJob).toHaveBeenCalledTimes(1);
  });
});
