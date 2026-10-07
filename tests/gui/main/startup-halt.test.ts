import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { finishStartupHalt, QUIT_BOUNDS_MS } from "../../../src/gui/main/quit.js";
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("presentation rejection and stalled cleanup still reach the fatal exit within the tail budget", async () => {
  const error = new Error("dialog unavailable");
  const onFailed = vi.fn();
  const exit = vi.fn();
  const never = () => new Promise<void>(() => {});
  const work = finishStartupHalt({ present: async () => { throw error; }, closeBackups: never, closeLog: never, onFailed, exit });
  await vi.advanceTimersByTimeAsync(QUIT_BOUNDS_MS.backups + QUIT_BOUNDS_MS.log);
  await work;
  expect(onFailed).toHaveBeenCalledWith(error);
  expect(exit).toHaveBeenCalledWith(1);
});
