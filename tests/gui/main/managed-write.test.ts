import { describe, expect, it } from "vitest";
import { writeManagedTextWithin } from "../../../src/gui/main/managed-write.js";

describe("writeManagedTextWithin", () => {
  it("gives up on a write that does not answer within its bound, and returns", () => {
    // The wait is the OS's own (Atomics.wait), which a fake clock cannot drive; the bound is kept short.
    const silent = new URL("./workers/silent.mjs", import.meta.url);
    const started = performance.now();

    expect(() => writeManagedTextWithin("/unused/queue.json", "{}", 50, silent)).toThrow(/did not finish within 50 ms/);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
