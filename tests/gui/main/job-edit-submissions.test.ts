import { expect, it, vi } from "vitest";
import { createJobEditSubmissions } from "../../../src/gui/preload/job-edits.js";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";
import { stopFlushAndExit, type QuitSteps } from "../../../src/gui/main/quit.js";

function gate() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
it("quit joins an issued edit before closing admission or saving the final snapshot", async () => {
  const delivery = gate();
  let accepting = true, comment = "old";
  const submissions = createJobEditSubmissions(async () => {
    await delivery.promise;
    if (!accepting) throw new Error("edit admission closed too early");
    comment = "last keystroke";
  });
  const edit = submissions.submit("job", { intent: "save" });
  const noop = async () => {};
  const steps: QuitSteps = {
    captureEdits: () => submissions.capture(),
    stopJob: vi.fn(async () => { accepting = false; }),
    flush: vi.fn(async () => { expect(comment).toBe("last keystroke"); }),
    settleSettings: noop, settleLayout: noop, closeBackups: noop, closeLog: noop,
    askSettingsNotSaved: async () => "cancel", askQueueNotSaved: async () => "cancel",
    onFlushed: vi.fn(), onCancelled: vi.fn(), onStepFailed: vi.fn(),
    exit: vi.fn(), forceExit: vi.fn(), nativeWorkPending: () => false,
  };
  const quit = stopFlushAndExit(steps, { ending: false, signal: new AbortController().signal });
  await Promise.resolve();
  expect(steps.stopJob).not.toHaveBeenCalled();
  await expect(submissions.submit("job", { intent: "save" })).rejects.toThrow("suspended");
  delivery.resolve(); await Promise.all([edit, quit]);
  expect(steps.flush).toHaveBeenCalledOnce();
  expect(steps.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(steps.onStepFailed).not.toHaveBeenCalled();
});

it("Retry preserves the latest options and intent after an older issued edit fails", async () => {
  const older = gate();
  const send = vi.fn<(id: string, patch: { intent?: "save" | "archive-and-trash"; options?: typeof DEFAULT_OPTIONS }) => Promise<void>>()
    .mockImplementationOnce(() => older.promise).mockResolvedValue(undefined);
  const submissions = createJobEditSubmissions(send);
  const first = submissions.submit("job", { options: { ...DEFAULT_OPTIONS, comment: "older" } }).catch(() => {});
  await submissions.submit("job", { options: { ...DEFAULT_OPTIONS, comment: "latest" } });
  await submissions.submit("job", { intent: "archive-and-trash" });
  const capture = submissions.capture();
  older.reject(new Error("old delivery failed"));
  await first;
  await expect(capture).rejects.toThrow("old delivery failed");
  await submissions.capture();
  expect(send).toHaveBeenLastCalledWith("job", { options: { ...DEFAULT_OPTIONS, comment: "latest" }, intent: "archive-and-trash" });
  expect(send).toHaveBeenCalledTimes(4);
});

it("a late capture completion cannot retire newer submissions after Cancel", async () => {
  const first = gate(), newer = gate();
  const send = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => newer.promise);
  const submissions = createJobEditSubmissions(send);
  const edit = submissions.submit("job", { intent: "save" });
  const stale = submissions.capture();
  submissions.resume();
  const latest = submissions.submit("job", { intent: "archive-and-trash" });
  let complete = false;
  const current = submissions.capture().then(() => { complete = true; });
  first.resolve(); await Promise.all([edit, stale]);
  expect(complete).toBe(false);
  newer.resolve(); await Promise.all([latest, current]);
  expect(complete).toBe(true);
});
