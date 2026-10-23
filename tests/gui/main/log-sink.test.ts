/** Held outbound sinks prove admission, timeout ownership and late responses. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
import type { RecordsRequest } from "../../../src/gui/main/records-worker.js";

interface TestWorker extends EventEmitter {
  messages: RecordsRequest[];
  terminate: ReturnType<typeof vi.fn>;
}
const fixture = vi.hoisted(() => ({
  workers: [] as TestWorker[],
  append: vi.fn<(...args: unknown[]) => Promise<void>>(),
  mkdir: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));
vi.mock("node:os", () => ({ totalmem: () => 512 * 1024 * 1024 }));
vi.mock("node:fs/promises", () => ({
  mkdir: fixture.mkdir,
  writeFile: vi.fn(async () => undefined),
  appendFile: fixture.append,
}));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      messages: RecordsRequest[] = [];
      terminate = vi.fn(async () => 0);
      constructor() { super(); fixture.workers.push(this); }
      unref(): void {}
      postMessage(request: RecordsRequest): void {
        this.messages.push(request);
        if (request.type === "close") queueMicrotask(() => this.emit("message", { type: "closed" }));
      }
    },
  };
});
import { createAppLog, diagnosticBudgetBytes, LOG_FALLBACK_WAIT_MS } from "../../../src/gui/main/log.js";

beforeEach(() => {
  fixture.workers.length = 0;
  fixture.append.mockReset().mockResolvedValue(undefined);
  fixture.mkdir.mockReset().mockResolvedValue(undefined);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function worker(): TestWorker { return fixture.workers[0]!; }
function writeRequests(): Exclude<RecordsRequest, { type: "close" }>[] {
  return worker().messages.filter((request) => request.type === "log" || request.type === "jobEvent") as Exclude<RecordsRequest, { type: "close" }>[];
}

describe("bounded diagnostic sinks", () => {
  it("derives its shared allowance from machine memory and clamps the diagnostic footprint", () => {
    expect(diagnosticBudgetBytes(1024)).toBe(128 * 1024);
    expect(diagnosticBudgetBytes(8 * 1024 ** 3)).toBe(2 * 1024 ** 2);
    expect(diagnosticBudgetBytes(128 * 1024 ** 3)).toBe(8 * 1024 ** 2);
  });

  it("drops newly arriving writes when acknowledgements stall and reuses admitted capacity after settlement", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const log = createAppLog("/test/records.sqlite3", "/test/logs");
    for (let i = 0; i < 20; i++) log.info("held", { data: "x".repeat(40_000) });
    expect(writeRequests()).toHaveLength(3);
    await tick();
    expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toContain("17 diagnostic records lost");
    const first = writeRequests()[0]!;
    worker().emit("message", { type: "written", id: first.id });
    log.info("next", { data: "y".repeat(40_000) });
    expect(writeRequests()).toHaveLength(4);
    await log.close();
  });

  it("owns one stalled append through timeout, drains waiting rows, and never issues another append", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let release!: () => void;
    fixture.append.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const log = createAppLog("/test/records.sqlite3", "/test/logs");
    await log.close();
    for (let i = 0; i < 20; i++) log.info(`held-${i}`, { data: "x".repeat(40_000) });
    await tick();
    expect(fixture.append).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LOG_FALLBACK_WAIT_MS);
    const output = stderr.mock.calls.map(([line]) => String(line)).join("");
    expect(output).toContain("outcome is unknown");
    expect(output).toContain('"held-1"');
    expect(output).toContain('"held-2"');
    expect(output).not.toContain('"held-0"');
    log.info("later");
    expect(stderr.mock.calls.some(([line]) => String(line).includes('"later"'))).toBe(true);
    // The caller's bounded close does not settle or forget the physical write.
    const closing = log.close(50);
    await vi.advanceTimersByTimeAsync(50);
    await closing;
    release();
    await tick();
    await log.close();
    expect(fixture.append).toHaveBeenCalledTimes(1);
  });

  it("sends an unattempted row to stderr when setup stalls and stops file work after timeout", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let release!: () => void;
    fixture.mkdir.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const log = createAppLog("/test/records.sqlite3", "/test/logs");
    await log.close();
    log.info("unattempted row");
    await vi.advanceTimersByTimeAsync(LOG_FALLBACK_WAIT_MS);
    expect(stderr.mock.calls.some(([line]) => String(line).includes('"unattempted row"'))).toBe(true);
    release();
    await tick();
    await log.close();
    expect(fixture.append).not.toHaveBeenCalled();
  });

  it("does not feed stderr while the stream is backpressured", async () => {
    let blocked = true;
    vi.spyOn(process.stderr, "writableNeedDrain", "get").mockImplementation(() => blocked);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const log = createAppLog("/test/records.sqlite3", "/test/logs");
    for (let i = 0; i < 100; i++) log.info("held", { data: "x".repeat(40_000) });
    await tick();
    expect(stderr).not.toHaveBeenCalled();
    blocked = false;
    await log.close();
    expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toContain("97 diagnostic records lost");
  });

  it("notifies once when the first write fails, rejects pending reads, and ignores late acknowledgements", async () => {
    const log = createAppLog("/test/records.sqlite3", "/test/logs");
    const stored = vi.fn();
    log.onStored(stored);
    log.info("first");
    log.info("second");
    const read = log.records({ op: "sessions" });
    const rejected = expect(read).rejects.toThrow(/stopped/);
    const writes = writeRequests();
    worker().emit("message", { type: "failed", id: writes[0]!.id, error: { message: "locked" } });
    await rejected;
    worker().emit("message", { type: "written", id: writes[1]!.id });
    worker().emit("message", { type: "failed", id: 99999, error: { message: "late" } });
    expect(worker().terminate).toHaveBeenCalledTimes(1);
    expect(stored).toHaveBeenCalledTimes(1);
    await expect(log.records({ op: "sessions" })).rejects.toThrow(/closed/);
    await log.close();
    const lines = fixture.append.mock.calls.map(([, line]) => JSON.parse(String(line)) as { message: string });
    expect(lines.map((line) => line.message)).toEqual(["records database unavailable", "first", "second"]);
  });

  it("ignores a write acknowledgement delivered after close has diverted that row", async () => {
    const log = createAppLog("/test/records.sqlite3", "/test/logs");
    const stored = vi.fn();
    log.onStored(stored);
    log.info("diverted");
    const request = writeRequests()[0]!;
    await log.close();
    worker().emit("message", { type: "written", id: request.id });
    worker().emit("message", { type: "failed", id: request.id, error: { message: "late failure" } });
    log.info("after close");
    await log.close();
    expect(stored).not.toHaveBeenCalled();
    expect(worker().terminate).toHaveBeenCalledTimes(1);
    expect(fixture.append.mock.calls.map(([, line]) => JSON.parse(String(line)) as { message: string }).map((line) => line.message))
      .toEqual(["diverted", "after close"]);
  });

  it("removes timed-out reads, caps concurrent reads, and keeps read failures separate from write failure", async () => {
    const log = createAppLog("/test/records.sqlite3", "/test/logs");
    const pending = Array.from({ length: 32 }, () => log.records({ op: "sessions" }, 50));
    const settled = Promise.allSettled(pending);
    await expect(log.records({ op: "sessions" }, 50)).rejects.toThrow(/too many/);
    await vi.advanceTimersByTimeAsync(50);
    expect((await settled).every((value) => value.status === "rejected")).toBe(true);
    const next = log.records({ op: "sessions" });
    const nextRequest = worker().messages.at(-1)!;
    if (nextRequest.type === "close") throw new Error("unexpected close");
    worker().emit("message", { type: "failed", id: 1, error: { message: "late" } });
    worker().emit("message", { type: "failed", id: nextRequest.id, error: { message: "read only transient" } });
    await expect(next).rejects.toThrow("read only transient");
    log.info("write still enabled");
    expect(writeRequests()).toHaveLength(1);
    const last = writeRequests()[0]!;
    worker().emit("message", { type: "written", id: last.id });
    await log.close();
    expect(fixture.append).not.toHaveBeenCalled();
  });
});
