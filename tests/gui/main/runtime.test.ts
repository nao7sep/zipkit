import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  jobEvent: vi.fn((jobId: string, event: unknown, action: string, run: string) => ({ jobId, session: "s", seq: 1, action, run, event })),
}));

vi.mock("electron", () => ({ BrowserWindow: class {} }));
vi.mock("../../../src/gui/main/log.js", () => ({ createAppLog: () => ({ jobEvent: hoisted.jobEvent }) }));

import { ZipKitError } from "zipkitsdk";
import {
  clearMainWindow,
  ensureMainWindow,
  getMainWindow,
  startProgressRun,
  EVENT_BATCH_MS,
  toGuiError,
} from "../../../src/gui/main/runtime.js";
import type { LogEvent } from "../../../src/gui/shared/api.js";

function fakeWindow() {
  return {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: { isDestroyed: () => false, send: vi.fn() },
  };
}

afterEach(() => {
  const current = getMainWindow();
  if (current) clearMainWindow(current);
});

describe("main-window ownership", () => {
  it("creates at most one live owner", () => {
    const first = fakeWindow();
    const second = fakeWindow();
    const createFirst = vi.fn(() => first as never);
    const createSecond = vi.fn(() => second as never);

    expect(ensureMainWindow(createFirst)).toMatchObject({ window: first, created: true });
    expect(ensureMainWindow(createSecond)).toMatchObject({ window: first, created: false });
    expect(createFirst).toHaveBeenCalledOnce();
    expect(createSecond).not.toHaveBeenCalled();
  });

  it("a stale closed callback cannot clear a replacement owner", () => {
    const first = fakeWindow();
    const replacement = fakeWindow();
    ensureMainWindow(() => first as never);
    first.destroyed = true;
    ensureMainWindow(() => replacement as never);

    clearMainWindow(first as never);

    expect(getMainWindow()).toBe(replacement);
  });
});

describe("SDK events", () => {
  const event = { time: "t", level: "info", message: "m", stage: "plan", event: "plan.done" } as unknown as LogEvent;

  // Each test's batch is sent before the next begins.
  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.jobEvent.mockClear();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });



  it("records an event under its job and run when no window is open", () => {
    const sink = startProgressRun("job-1", "plan");
    sink(event);
    sink(event);

    expect(hoisted.jobEvent).toHaveBeenCalledTimes(2);
    const [first, second] = hoisted.jobEvent.mock.calls;
    expect(first?.slice(0, 3)).toEqual(["job-1", event, "plan"]);
    expect(second?.[3]).toBe(first?.[3]); // one run id for the whole run
  });

  it("gives each run its own id", () => {
    startProgressRun("job-1", "create")(event);
    startProgressRun("job-1", "verify")(event);
    const [a, b] = hoisted.jobEvent.mock.calls;
    expect(a?.[3]).not.toBe(b?.[3]);
  });

  it("records each event at once and sends the window one batch of them", () => {
    {
      const win = fakeWindow();
      ensureMainWindow(() => win as never);
      const sink = startProgressRun("job-1", "verify");
      sink(event);
      sink(event);

      const run = hoisted.jobEvent.mock.calls[0]?.[3];
      expect(hoisted.jobEvent).toHaveBeenCalledTimes(2);
      expect(hoisted.jobEvent).toHaveBeenCalledWith("job-1", event, "verify", run);
      expect(win.webContents.send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(EVENT_BATCH_MS);
      const recorded = { jobId: "job-1", session: "s", seq: 1, action: "verify", run, event };
      expect(win.webContents.send).toHaveBeenCalledExactlyOnceWith("zipkit:events", [recorded, recorded]);
    }
  });

});

describe("GUI error presentation", () => {
  it("keeps arbitrary diagnostic text out of the renderer result", () => {
    const result = toGuiError(
      Object.assign(
        new TypeError("EACCES /private/tmp/HOSTILE-SENTINEL Error invoking remote method"),
        { code: "EACCES" },
      ),
    );

    expect(result).toEqual({
      kind: "internal",
      code: "unknown",
      presentation: { key: "error.verifyIncomplete" },
    });
    expect(JSON.stringify(result)).not.toContain("HOSTILE-SENTINEL");
  });

  it("presents an SDK failure by its kind, without its text", () => {
    const read = new ZipKitError("path.denied", "EACCES /private/HOSTILE");
    expect(toGuiError(read)).toEqual({ kind: "unavailable", code: "path.denied", presentation: { key: "error.readFailed" } });
    const write = new ZipKitError("write.source-changed", "x");
    expect(toGuiError(write).presentation).toEqual({ key: "error.verifyIncomplete" });
  });

  it("says a manifest of a newer format needs that version, not that the archive is unreadable", () => {
    const newer = new ZipKitError("manifest.newer", "manifest zipkit.json has format version 2");
    expect(toGuiError(newer)).toMatchObject({ code: "manifest.newer", presentation: { key: "error.manifestNewer" } });
  });
});
