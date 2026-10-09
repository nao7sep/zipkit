import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { finishStartupHalt, QUIT_BOUNDS_MS } from "../../../src/gui/main/quit.js";
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("presentation rejection and stalled cleanup still end the process within the tail budget, forcing it past stuck work", async () => {
  const error = new Error("dialog unavailable");
  const onFailed = vi.fn();
  const exit = vi.fn();
  const forceExit = vi.fn();
  const never = () => new Promise<void>(() => {});
  const work = finishStartupHalt({ present: async () => { throw error; }, closeBackups: never, closeLog: never, onFailed, exit, forceExit });
  await vi.advanceTimersByTimeAsync(QUIT_BOUNDS_MS.backups + QUIT_BOUNDS_MS.log);
  await work;
  expect(onFailed).toHaveBeenCalledWith(error);
  expect(forceExit).toHaveBeenCalledOnce();
  expect(exit).not.toHaveBeenCalled();
});

it("a halt whose cleanup settles exits with failure through the ordinary exit", async () => {
  const exit = vi.fn();
  const forceExit = vi.fn();
  await finishStartupHalt({ present: async () => {}, closeBackups: async () => {}, closeLog: async () => {}, onFailed: vi.fn(), exit, forceExit });
  expect(exit).toHaveBeenCalledWith(1);
  expect(forceExit).not.toHaveBeenCalled();
});
