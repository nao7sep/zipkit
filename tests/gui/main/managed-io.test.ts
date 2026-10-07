import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { managedIO } from "../../../src/gui/main/managed-io.js";
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("bounds the caller while a timed-out operation retains actual ordering and cleanup", async () => {
  let release!: () => void;
  let entered!: () => void;
  const seen = new Promise<void>((resolve) => { entered = resolve; });
  const order: string[] = [];
  const first = managedIO("held-write", async () => {
    entered();
    await new Promise<void>((resolve) => { release = resolve; });
    order.push("physical cleanup");
  }, 50);
  const failed = expect(first).rejects.toThrow("did not finish within 50 ms");
  await seen;
  await vi.advanceTimersByTimeAsync(50);
  await failed;
  const second = managedIO("held-write", async () => { order.push("next write"); }, 100);
  await Promise.resolve();
  expect(order).toEqual([]);
  release();
  await second;
  expect(order).toEqual(["physical cleanup", "next write"]);
});

it("an expired queued operation does not begin later when the prior I/O finally returns", async () => {
  let release!: () => void;
  let entered!: () => void;
  const seen = new Promise<void>((resolve) => { entered = resolve; });
  const first = managedIO("expired-queued", async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); }, 100);
  await seen;
  const start = vi.fn(async () => {});
  const queued = managedIO("expired-queued", start, 50);
  const failed = expect(queued).rejects.toThrow("did not finish within 50 ms");
  await vi.advanceTimersByTimeAsync(50);
  await failed;
  release();
  await first;
  await Promise.resolve();
  expect(start).not.toHaveBeenCalled();
});
