/**
 * SIGINT handling. Each run must get its own controller so a cancellation
 * never leaks between successive `runCli` calls in one process.
 */

import { describe, expect, it } from "vitest";
import { installSigintHandler } from "../../src/cli/abort.js";

describe("installSigintHandler", () => {
  it("returns a fresh, non-aborted signal on each call", () => {
    const first = installSigintHandler();
    const second = installSigintHandler();
    expect(first).not.toBe(second);
    expect(second.aborted).toBe(false);
  });
});
