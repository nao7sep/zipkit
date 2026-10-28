/** Held outbound sinks prove write-failure diversion, reply routing and that a let-go thread speaks no more. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
import type { RecordsRequest } from "../../../src/gui/main/records-worker.js";

interface TestWorker extends EventEmitter {
  messages: RecordsRequest[];
  terminate: ReturnType<typeof vi.fn>;
}
const fixture = vi.hoisted(() => ({
  workers: [] as TestWorker[],
  lines: [] as string[],
}));
vi.mock("node:fs", () => ({
  mkdirSync: () => undefined,
  openSync: () => 3,
  createWriteStream: () => ({
    write: (line: string) => { fixture.lines.push(line); return true; },
    end: (done: () => void) => done(),
    on: () => undefined,
  }),
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
import { createAppLog } from "../../../src/gui/main/log.js";

beforeEach(() => {
  fixture.workers.length = 0;
  fixture.lines.length = 0;
});
afterEach(() => { vi.restoreAllMocks(); });
const fallbackMessages = (): string[] => fixture.lines.map((line) => (JSON.parse(line) as { message: string }).message);

function worker(): TestWorker { return fixture.workers[0]!; }
function writeRequests(): Exclude<RecordsRequest, { type: "close" }>[] {
  return worker().messages.filter((request) => request.type === "log" || request.type === "jobEvent") as Exclude<RecordsRequest, { type: "close" }>[];
}

describe("records sinks", () => {
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
    expect(fallbackMessages()).toEqual(["records database unavailable", "first", "second"]);
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
    expect(fallbackMessages()).toEqual(["diverted", "after close"]);
  });

  it("keeps read failures separate from write failure", async () => {
    const log = createAppLog("/test/records.sqlite3", "/test/logs");
    const next = log.records({ op: "sessions" });
    const nextRequest = worker().messages.at(-1)!;
    if (nextRequest.type === "close") throw new Error("unexpected close");
    worker().emit("message", { type: "failed", id: nextRequest.id, error: { message: "read only transient" } });
    await expect(next).rejects.toThrow("read only transient");
    log.info("write still enabled");
    expect(writeRequests()).toHaveLength(1);
    const last = writeRequests()[0]!;
    worker().emit("message", { type: "written", id: last.id });
    await log.close();
    expect(fixture.lines).toEqual([]);
  });
});
