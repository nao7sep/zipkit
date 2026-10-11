import { expect, it, vi } from "vitest";
import { nativeWorkPending } from "../../../src/gui/main/pending-work.js";
import { managedIO } from "../../../src/gui/main/managed-io.js";
import { stopFlushAndExit, finishStartupHalt, type QuitSteps } from "../../../src/gui/main/quit.js";
import { nodeFileSystem, Volume } from "../../../src/sdk/internal/volume.js";

it("forces the final exit after an SDK caller was cancelled but its raw call is still pending", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const volume = new Volume({ ...nodeFileSystem, realpath: async () => { await gate; return "/fixture"; } }, 1000, controller.signal);
  const caller = volume.realpath("/fixture");
  controller.abort();
  await expect(caller).rejects.toMatchObject({ errorType: "abort" });
  const noop = async () => {};
  const steps: QuitSteps = { stopJob: noop, settleSettings: noop, flush: noop, settleLayout: noop,
    closeBackups: noop, closeLog: noop, onFlushed: () => {}, onCancelled: () => {}, onStepFailed: vi.fn(),
    askSettingsNotSaved: async () => "quit", askQueueNotSaved: async () => "quit",
    nativeWorkPending, exit: vi.fn(), forceExit: vi.fn() };
  try {
    expect(nativeWorkPending()).toBe(true);
    await stopFlushAndExit(steps, { ending: false, signal: new AbortController().signal });
    expect(steps.onStepFailed).not.toHaveBeenCalled();
    expect(steps.exit).not.toHaveBeenCalled();
    expect(steps.forceExit).toHaveBeenCalledOnce();
  } finally { release(); await vi.waitFor(() => expect(nativeWorkPending()).toBe(false)); }
});

it("forces a startup halt while a timed-out managed read retains its actual path tail", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const work = managedIO("/disposable-managed-read", () => gate, 1);
  await expect(work).rejects.toThrow("did not finish");
  const exit = vi.fn(), forceExit = vi.fn();
  try {
    await finishStartupHalt({ present: async () => {}, closeBackups: async () => {}, closeLog: async () => {},
      onFailed: vi.fn(), nativeWorkPending, exit, forceExit });
    expect(exit).not.toHaveBeenCalled();
    expect(forceExit).toHaveBeenCalledOnce();
  } finally { release(); await vi.waitFor(() => expect(nativeWorkPending()).toBe(false)); }
});
