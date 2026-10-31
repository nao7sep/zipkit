/** The real SQLite writer refuses queued writes after its first busy failure. */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { createAppLog } from "../../../src/gui/main/log.js";
import type { LogRow, RecordsRequest, RecordsResponse } from "../../../src/gui/main/records-worker.js";

it("marks a write failure before the next mailbox message, without disabling reads", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zipkit-records-lock-"));
  const database = path.join(dir, "records.sqlite3");
  const seed = createAppLog(database, path.join(dir, "logs"));
  await seed.records({ op: "sessions" });
  await seed.close();
  const worker = new Worker(new URL("../../../src/gui/main/records-worker.ts", import.meta.url), { workerData: { database, writer: { name: "zipkit", version: "1.0.0" } } });
  const lock = new DatabaseSync(database);
  const replies: RecordsResponse[] = [];
  worker.on("message", (response: RecordsResponse) => replies.push(response));
  const send = (request: RecordsRequest) => worker.postMessage(request);
  try {
    // Initialize the worker before taking a real separate-connection write lock.
    const initialized = once(worker, "message");
    send({ type: "readRecords", id: 1, read: { op: "sessions" } });
    await initialized;
    lock.exec("BEGIN IMMEDIATE");
    const row: LogRow = { time: new Date().toISOString(), session: "session", level: "info", message: "held", jobId: null, fields: "{}" };
    const firstFailure = once(worker, "message");
    send({ type: "log", id: 2, row });
    send({ type: "log", id: 3, row: { ...row, message: "must never retry" } });
    const [first] = await firstFailure as [RecordsResponse];
    expect(first).toMatchObject({ type: "failed", id: 2, error: { errcode: 5 } });
    lock.exec("ROLLBACK");
    const closed = once(worker, "exit");
    send({ type: "readRecords", id: 4, read: { op: "sessions" } });
    send({ type: "close" });
    await closed;
    expect(replies.find((reply) => "id" in reply && reply.id === 3)).toMatchObject({ type: "failed", id: 3 });
    expect(replies.find((reply) => "id" in reply && reply.id === 4)).toMatchObject({ type: "records", value: [] });
    expect(lock.prepare("SELECT COUNT(*) AS count FROM logs").get()).toMatchObject({ count: 0 });
  } finally {
    await worker.terminate();
    lock.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
