import { expect, it, vi } from "vitest";
import { nativeWorkPending } from "../../../src/gui/main/pending-work.js";
import { managedIO } from "../../../src/gui/main/managed-io.js";
import { finishStartupHalt } from "../../../src/gui/main/quit.js";

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
