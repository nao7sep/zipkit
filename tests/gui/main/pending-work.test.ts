import { expect, it, vi } from "vitest";
import { nativeWorkPending } from "../../../src/gui/main/pending-work.js";
import { managedIO } from "../../../src/gui/main/managed-io.js";
import { finishStartupHalt } from "../../../src/gui/main/quit.js";
import { nodeFileSystem, Volume } from "zipkit/testing";

it("leaves main's exit unheld by SDK volume work, which runs in the SDK host's own process", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const volume = new Volume({ ...nodeFileSystem, realpath: async () => { await gate; return "/fixture"; } }, 1000);
  const pending = volume.realpath("/fixture");
  try {
    expect(nativeWorkPending()).toBe(false);
  } finally { release(); await pending; }
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
