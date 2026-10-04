import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  zipOptions: [] as unknown[],
  jobEvent: vi.fn((jobId: string, event: unknown) => ({ jobId, session: "s", seq: 1, event })),
}));

vi.mock("electron", () => ({ BrowserWindow: class {} }));
vi.mock("../../../src/sdk/index.js", () => {
  class ZipKitError extends Error {}
  class StallError extends ZipKitError {
    readonly errorType = "stall";
    readonly code = "io.stalled";
    constructor(readonly path: string) {
      super(`read did not respond within 30000 ms: ${path}`);
    }
  }
  class ZipKit {
    constructor(options: unknown) {
      hoisted.zipOptions.push(options);
    }
  }
  return { ZipKit, ZipKitError, StallError };
});
vi.mock("../../../src/gui/main/log.js", () => ({ createAppLog: () => ({ jobEvent: hoisted.jobEvent }) }));

import { StallError } from "../../../src/sdk/index.js";
import {
  clearMainWindow,
  ensureMainWindow,
  getMainWindow,
  sendEvent,
  setMainWindow,
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

describe("main-window ownership", () => {
  beforeEach(() => setMainWindow(null));

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
    setMainWindow(first as never);
    setMainWindow(replacement as never);

    clearMainWindow(first as never);

    expect(getMainWindow()).toBe(replacement);
  });
});

describe("SDK events", () => {
  const event = { time: "t", level: "info", message: "m", stage: "plan", event: "plan.done" } as unknown as LogEvent;

  beforeEach(() => {
    setMainWindow(null);
    hoisted.jobEvent.mockClear();
  });

  it("builds the one SDK instance without a session log file of its own", () => {
    expect(hoisted.zipOptions).toEqual([{ sessionLog: false }]);
  });

  it("records an event under its job when no window is open", () => {
    sendEvent("job-1", event);

    expect(hoisted.jobEvent).toHaveBeenCalledExactlyOnceWith("job-1", event);
  });

  it("records an event, then sends the recorded event to the open window", () => {
    const win = fakeWindow();
    setMainWindow(win as never);

    sendEvent("job-1", event);

    expect(hoisted.jobEvent).toHaveBeenCalledExactlyOnceWith("job-1", event);
    expect(win.webContents.send).toHaveBeenCalledExactlyOnceWith("zipkit:event", {
      jobId: "job-1",
      session: "s",
      seq: 1,
      event,
    });
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
      type: "unknown",
      code: "unknown",
      presentation: { key: "error.verifyIncomplete" },
    });
    expect(JSON.stringify(result)).not.toContain("HOSTILE-SENTINEL");
  });

  it("names the path that stopped responding for a stalled volume", () => {
    const StallErrorMock = StallError as unknown as new (path: string) => Error;
    expect(toGuiError(new StallErrorMock("/Volumes/NAS/a.zip"))).toEqual({
      type: "stall",
      code: "io.stalled",
      presentation: { key: "error.stalled", values: { path: "/Volumes/NAS/a.zip" } },
    });
  });
});
