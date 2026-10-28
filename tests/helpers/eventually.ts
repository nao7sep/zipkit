/**
 * Waiting for a state a test cannot await directly. The check runs again after
 * each turn of the event loop until it passes, with no deadline of its own: the
 * runner's timeout is off (tests-folder conventions), so a state that never
 * comes is a test that does not finish. Under fake timers a turn runs what is
 * due without moving the clock, so a delay the test needs is advanced by the
 * test itself.
 */
import { act } from "react";
import { vi } from "vitest";

async function nextTurn(): Promise<void> {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function eventually<T>(check: () => T | Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await check();
    } catch {
      await nextTurn();
    }
  }
}

/** {@link eventually} for a rendered window: each turn runs inside `act`, so
 *  React applies the updates it caused before the check looks again. */
export async function eventuallyRendered<T>(check: () => T | Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await check();
    } catch {
      await act(nextTurn);
    }
  }
}
