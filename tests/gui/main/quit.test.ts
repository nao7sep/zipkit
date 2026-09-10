import { describe, expect, it, vi } from "vitest";
import { flushThenExit } from "../../../src/gui/main/quit.js";

describe("flushThenExit", () => {
  it("waits for the queue flush before exiting", async () => {
    let finishQueue!: () => void;
    const queue = new Promise<void>((resolve) => { finishQueue = resolve; });
    const onSuccess = vi.fn();
    const exit = vi.fn();

    const quitting = flushThenExit(queue, onSuccess, vi.fn(), exit);
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();

    finishQueue();
    await quitting;
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("reports a failed flush and still exits deterministically", async () => {
    const error = new Error("flush failed");
    const onError = vi.fn();
    const exit = vi.fn();

    await flushThenExit(Promise.reject(error), vi.fn(), onError, exit);

    expect(onError).toHaveBeenCalledWith(error);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
