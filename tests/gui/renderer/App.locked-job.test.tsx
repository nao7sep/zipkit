// @vitest-environment jsdom

/** Normal job edits immediately reach the queue owner. Locking a job restores
 * the accepted options, and switching panes does not produce a delayed edit. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../../src/gui/renderer/src/App";
import { DialogHost } from "../../../src/gui/renderer/src/components/DialogHost";
import type { Job } from "../../../src/gui/shared/api";
import { DEFAULT_LAYOUT } from "../../../src/gui/shared/layout";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec";
import { SAVE } from "../../helpers/intents.js";

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

// Options that differ from the defaults, so the pane's "Use the parameters from Settings" is
// off and the parameter controls are live.
const CUSTOM_OPTIONS = { ...DEFAULT_OPTIONS, level: 3 };

const readyJob: Job = {
  id: "job-1",
  inputs: ["/tmp/thing.txt"],
  entries: [{ path: "/tmp/thing.txt", kind: "file" }],
  options: CUSTOM_OPTIONS,
  intent: SAVE,
  state: "ready",
};
const otherJob: Job = { ...readyJob, id: "job-2", inputs: ["/tmp/other.txt"], entries: [{ path: "/tmp/other.txt", kind: "file" }] };

/** Type into a React-controlled field the way a keystroke does, without leaving it. */
function typeInto(field: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
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
          listener([readyJob, otherJob]);
          return () => {};
        },
        onQueueSaved: () => () => {},
        onSettingsChanged: vi.fn(() => () => {}),
        onOpenAbout: vi.fn(() => () => {}),
        getSettings: async () => ({ defaults: DEFAULT_OPTIONS, uiFontFamily: "" }),
        getLayout: async () => DEFAULT_LAYOUT,
        getPlan: async () => null,
        refreshJob: async () => {},
        getJobEvents: async () => [],
        onEvents: () => () => {},
        onProgress: () => () => {},
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
      .find((node) => node.textContent?.includes("Leave out what the exclusion patterns match"))!;
    return label.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  };
  const comment = (): HTMLTextAreaElement => container.querySelector("textarea")!;
  const level = (): HTMLInputElement => {
    const label = [...container.querySelectorAll("label")]
      .find((node) => node.textContent?.includes("Compression level"))!;
    return label.querySelector<HTMLInputElement>("input")!;
  };
  const create = (): HTMLButtonElement => [...container.querySelectorAll("button")]
    .find((node) => node.textContent === "Create archive") as HTMLButtonElement;

  it("sends a checkbox change at once", async () => {
    await renderApp();
    await openJob("job-1");

    expect(junk().checked).toBe(true);
    await act(async () => junk().click());

    expect(updateJob).toHaveBeenCalledWith("job-1", { options: { ...CUSTOM_OPTIONS, exclude: false } });
  });

  it("sends a typed edit immediately and shows accepted options when the job locks", async () => {
    await renderApp();
    await openJob("job-1");

    await act(async () => typeInto(comment(), "late words"));
    expect(comment().value).toBe("late words");

    // Main reports the accepted options of the finished job.
    await act(async () => pushQueue([{ ...readyJob, state: "done", output: "/tmp/thing.zip" }, otherJob]));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(updateJob).toHaveBeenCalledExactlyOnceWith("job-1", { options: { ...CUSTOM_OPTIONS, comment: "late words" } });
    expect(comment().value).toBe(CUSTOM_OPTIONS.comment);
  });

  it("sends typing before another job is selected without a second unmount save", async () => {
    await renderApp();
    await openJob("job-1");

    await act(async () => typeInto(comment(), "for the client"));
    expect(updateJob).toHaveBeenCalledOnce();
    await openJob("job-2");

    expect(updateJob).toHaveBeenCalledTimes(1);
    expect(updateJob).toHaveBeenCalledWith("job-1", { options: { ...CUSTOM_OPTIONS, comment: "for the client" } });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(updateJob).toHaveBeenCalledTimes(1);
  });

  it("keeps a typed level that is not one, sends only valid levels and holds Create back", async () => {
    await renderApp();
    await openJob("job-1");

    for (const typed of ["", "0", "10", "4.5"]) {
      await act(async () => typeInto(level(), typed));
      expect(level().value).toBe(typed);
      expect(level().getAttribute("aria-invalid")).toBe("true");
      expect(container.textContent).toContain("Whole number from 1 to 9");
      expect(container.textContent).toContain("Create archive waits until the compression level under Parameters is valid.");
      expect(create().disabled).toBe(true);
    }
    expect(updateJob).not.toHaveBeenCalled();

    await act(async () => typeInto(level(), "7"));
    expect(updateJob).toHaveBeenCalledExactlyOnceWith("job-1", { options: { ...CUSTOM_OPTIONS, level: 7 } });
    expect(container.textContent).not.toContain("Whole number from 1 to 9");
    expect(create().disabled).toBe(false);
  });

  it("keeps a job's typed level when another job is selected and back", async () => {
    await renderApp();
    await openJob("job-1");
    await act(async () => typeInto(level(), "12"));

    await openJob("job-2");
    expect(level().value).toBe(String(CUSTOM_OPTIONS.level));
    expect(create().disabled).toBe(false);
    await openJob("job-1");
    expect(level().value).toBe("12");
    expect(create().disabled).toBe(true);
    expect(updateJob).not.toHaveBeenCalled();
  });
});
