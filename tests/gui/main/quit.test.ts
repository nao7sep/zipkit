import { describe, expect, it, vi } from "vitest";
import { flushThenExit } from "../../../src/gui/main/quit.js";

describe("flushThenExit", () => {
  it("waits for all owned flushes before exiting", async () => {
    let finishPlacement!: () => void;
    const placement = new Promise<void>((resolve) => { finishPlacement = resolve; });
    const onSuccess = vi.fn();
    const exit = vi.fn();

    const quitting = flushThenExit([Promise.resolve(), placement], onSuccess, vi.fn(), exit);
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();

    finishPlacement();
    await quitting;
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("reports a failed flush and still exits deterministically", async () => {
    const error = new Error("flush failed");
    const onError = vi.fn();
    const exit = vi.fn();

    await flushThenExit([Promise.reject(error)], vi.fn(), onError, exit);

    expect(onError).toHaveBeenCalledWith(error);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
