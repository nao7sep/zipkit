// @vitest-environment jsdom

/**
 * A job that finishes while an edit is still in flight. The pane commits option
 * changes on a 250 ms debounce, and that timer outlives the edit: it used to land
 * on a job the engine had already finished. The engine now refuses such a write,
 * so the pane must not keep showing a value the job never took.
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
        getQueue: async () => [readyJob],
        getSettings: async () => ({ defaults: DEFAULT_OPTIONS, uiFontFamily: "" }),
        getLayout: async () => DEFAULT_LAYOUT,
        getPlan: async () => null,
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

  it("drops the pending option commit and shows the options the job kept", async () => {
    await act(async () => {
      root?.render(
        <DialogHost>
          <App />
        </DialogHost>,
      );
    });

    const row = container.querySelector<HTMLElement>('[data-job-id="job-1"]')!;
    await act(async () => row.click());

    const junk = (): HTMLInputElement => {
      const label = [...container.querySelectorAll("label")]
        .find((node) => node.textContent?.includes("Drop OS junk files"))!;
      return label.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    };
    expect(junk().checked).toBe(true);
    await act(async () => junk().click());
    expect(junk().checked).toBe(false);

    // The job runs and finishes inside the debounce window.
    await act(async () => pushQueue([{ ...readyJob, state: "done", output: "/tmp/thing.zip" }]));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(updateJob).not.toHaveBeenCalled();
    expect(junk().checked).toBe(true);
  });
});
