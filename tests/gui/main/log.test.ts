/**
 * Tests for the app log's records and fallback, and its error serializer. The
 * serializer's trap: an Error's own properties are non-enumerable, so logging a
 * raw Error stringifies to `{}` — errorInfo must capture name/message/stack and
 * recurse the cause chain.
 */

import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAppLog, errorInfo } from "../../../src/gui/main/log.js";
import type { LogEvent } from "../../../src/gui/shared/api.js";
import type { RecordsPage } from "../../../src/gui/shared/records.js";

interface Row {
  time_utc: string;
  session_utc: string;
  level: string;
  message: string;
  job_id: string | null;
  fields: string;
}

function rows(file: string): Row[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT time_utc, session_utc, level, message, job_id, fields FROM logs ORDER BY id").all() as unknown as Row[];
  } finally {
    db.close();
  }
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "zipkit-log-"));
}

describe("createAppLog", () => {
  it("records each line with its session and job id, gates debug off by default, and keeps every field as given", async () => {
    const dir = tempDir();
    const database = path.join(dir, "records.sqlite3");
    const log = createAppLog(database, path.join(dir, "logs"), new Date("2026-06-14T05:25:48.123Z"));
    log.info("hello", { jobId: "a", password: "hunter2" });
    log.debug("noise"); // gated off — no ZIPKIT_DEBUG
    log.error("bad", { code: 7 });
    await log.close();

    const [first, second, ...rest] = rows(database);
    expect(rest).toHaveLength(0);
    expect(first).toMatchObject({ session_utc: "2026-06-14T05:25:48.123Z", level: "info", message: "hello", job_id: "a" });
    expect(JSON.parse(first?.fields ?? "")).toEqual({ jobId: "a", password: "hunter2" }); // logging conventions, Nothing is redacted
    expect(first?.time_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(second).toMatchObject({ level: "error", message: "bad", job_id: null });
    expect(JSON.parse(second?.fields ?? "")).toEqual({ code: 7 });
    expect(existsSync(path.join(dir, "logs"))).toBe(false); // no fallback file while the database takes every entry
  });

  it("appends to the same database across sessions, each row naming its own session", async () => {
    const dir = tempDir();
    const database = path.join(dir, "records.sqlite3");
    const first = createAppLog(database, path.join(dir, "logs"), new Date("2026-06-14T05:25:48.123Z"));
    first.info("first launch");
    await first.close();
    const second = createAppLog(database, path.join(dir, "logs"), new Date("2026-06-15T01:00:00.000Z"));
    second.info("second launch");
    await second.close();

    expect(rows(database).map((row) => [row.session_utc, row.message])).toEqual([
      ["2026-06-14T05:25:48.123Z", "first launch"],
      ["2026-06-15T01:00:00.000Z", "second launch"],
    ]);
  });

  it("never throws and keeps the line when a field cannot be JSON-serialized (e.g. a BigInt)", async () => {
    const dir = tempDir();
    const database = path.join(dir, "records.sqlite3");
    const log = createAppLog(database, path.join(dir, "logs"));

    expect(() => log.info("hello", { big: 10n })).not.toThrow();
    await log.close();

    const [row] = rows(database);
    expect(row).toMatchObject({ level: "info", message: "hello" });
    expect(typeof JSON.parse(row?.fields ?? "").serializationError).toBe("string");
  });

  it("keeps the real message and a caller field named `message` side by side", async () => {
    const dir = tempDir();
    const database = path.join(dir, "records.sqlite3");
    const log = createAppLog(database, path.join(dir, "logs"));

    log.info("the real message", { message: "given by caller" });
    await log.close();

    const [row] = rows(database);
    expect(row?.message).toBe("the real message");
    expect(JSON.parse(row?.fields ?? "")).toEqual({ message: "given by caller" });
  });

  it("falls back to a plain text file under logs/ when the database cannot be opened, naming the failure once", async () => {
    const dir = tempDir();
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "a file, not a directory");
    const logs = path.join(dir, "logs");
    const log = createAppLog(path.join(blocker, "records.sqlite3"), logs, new Date("2026-06-14T05:25:48.123Z"));

    log.info("first", { jobId: "a" });
    log.warn("second");
    await log.close();

    const lines = readFileSync(path.join(logs, "20260614-052548-123-utc.log"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => [line.level, line.message])).toEqual([
      ["error", "records database unavailable"],
      ["info", "first"],
      ["warn", "second"],
    ]);
    expect(lines[1]).toMatchObject({ session: "2026-06-14T05:25:48.123Z", fields: { jobId: "a" } });
  });

  it("degrades to the console instead of interleaving when the fallback file already exists", async () => {
    const dir = tempDir();
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "a file, not a directory");
    const logs = path.join(dir, "logs");
    const expectedPath = path.join(logs, "20260614-052548-123-utc.log");
    mkdirSync(logs);
    writeFileSync(expectedPath, "first-process-line\n");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const log = createAppLog(path.join(blocker, "records.sqlite3"), logs, new Date("2026-06-14T05:25:48.123Z"));
    log.info("second process");
    await log.close();

    expect(readFileSync(expectedPath, "utf8")).toBe("first-process-line\n");
    expect(stderrSpy.mock.calls.some(([line]) => String(line).includes("second process"))).toBe(true);
    stderrSpy.mockRestore();
  });

  it("hands a record still in flight to the fallback file when the database does not take it in time", async () => {
    const dir = tempDir();
    const database = path.join(dir, "records.sqlite3");
    const lock = new DatabaseSync(database);
    lock.exec("CREATE TABLE held (x)");
    lock.exec("BEGIN EXCLUSIVE");
    const logs = path.join(dir, "logs");
    const log = createAppLog(database, logs, new Date("2026-06-14T05:25:48.123Z"));

    const started = Date.now();
    log.info("while the database is locked");
    expect(Date.now() - started).toBeLessThan(1_000); // the caller never waits on the database
    await log.close(200);
    lock.exec("ROLLBACK");
    lock.close();

    const lines = readFileSync(path.join(logs, "20260614-052548-123-utc.log"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.message)).toEqual(["while the database is locked"]);
  });

  it("writes an entry made after close to the fallback file", async () => {
    const dir = tempDir();
    const logs = path.join(dir, "logs");
    const log = createAppLog(path.join(dir, "records.sqlite3"), logs, new Date("2026-06-14T05:25:48.123Z"));
    await log.close();
    log.info("late");
    await log.close();

    expect(readFileSync(path.join(logs, "20260614-052548-123-utc.log"), "utf8")).toContain("\"late\"");
  });
});

describe("job events", () => {
  const event = (time: string, extra: Record<string, unknown>): LogEvent =>
    ({ time, stage: "plan", level: "info", message: "m", ...extra }) as LogEvent;

  it("numbers each event in its launch and reads a job's events back across launches, oldest first", async () => {
    const dir = tempDir();
    const database = path.join(dir, "records.sqlite3");
    const first = createAppLog(database, path.join(dir, "logs"), new Date("2026-06-14T05:25:48.123Z"));
    const sent = first.jobEvent("a", event("2026-06-14T05:25:49.000Z", { event: "scan.start", inputs: 1 }));
    first.jobEvent("b", event("2026-06-14T05:25:49.500Z", { event: "scan.start", inputs: 2 }));
    await first.close();
    const second = createAppLog(database, path.join(dir, "logs"), new Date("2026-06-15T01:00:00.000Z"));
    second.jobEvent("a", event("2026-06-15T01:00:01.000Z", { event: "write.start", entries: 3 }));

    expect(sent).toMatchObject({ jobId: "a", session: "2026-06-14T05:25:48.123Z", seq: 1 });
    const read = await second.jobEvents("a");
    await second.close();
    expect(read.map((e) => [e.session, e.seq, e.event.event])).toEqual([
      ["2026-06-14T05:25:48.123Z", 1, "scan.start"],
      ["2026-06-15T01:00:00.000Z", 1, "write.start"],
    ]);
    expect(read[0]?.event).toEqual(sent.event);
  });

  it("writes an event the database cannot take to the fallback file and reads nothing", async () => {
    const dir = tempDir();
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "a file, not a directory");
    const logs = path.join(dir, "logs");
    const log = createAppLog(path.join(blocker, "records.sqlite3"), logs, new Date("2026-06-14T05:25:48.123Z"));

    log.jobEvent("a", event("2026-06-14T05:25:49.000Z", { event: "scan.start", inputs: 1 }));
    expect(await log.jobEvents("a")).toEqual([]);
    await log.close();

    const lines = readFileSync(path.join(logs, "20260614-052548-123-utc.log"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[1]).toMatchObject({ jobId: "a", seq: 1, event: { event: "scan.start", inputs: 1 } });
  });
});

describe("records reads for the Records window", () => {
  const event = (time: string, level: LogEvent["level"], extra: Record<string, unknown>): LogEvent =>
    ({ time, stage: "plan", level, message: `sdk says ${String(extra.event)}`, ...extra }) as LogEvent;
  const ALL = { session: null, kind: null, level: null, search: "", after: null } as const;

  // Two launches: log lines stamped as they are written, events at the SDK's own times.
  async function seeded(): Promise<{ log: ReturnType<typeof createAppLog>; database: string; dir: string }> {
    const dir = tempDir();
    const database = path.join(dir, "records.sqlite3");
    const first = createAppLog(database, path.join(dir, "logs"), new Date("2026-06-14T05:25:48.123Z"));
    first.jobEvent("a", event("2000-01-01T00:00:01.000Z", "info", { event: "scan.start", inputs: 1 }));
    first.jobEvent("a", event("2000-01-01T00:00:03.000Z", "warn", { event: "scan.symlink-unreadable", path: "/x" }));
    await first.close();
    const log = createAppLog(database, path.join(dir, "logs"), new Date("2026-06-15T01:00:00.000Z"));
    log.jobEvent("b", event("2000-01-01T00:00:02.000Z", "error", { event: "fault", code: "read", detail: "100% gone" }));
    log.info("app started", { version: "1" });
    log.error("verify failed", { jobId: "b", archive: "/out/b.zip" });
    return { log, database, dir };
  }

  const titles = (page: { records: { title: string }[] }) => page.records.map((record) => record.title);

  it("pages every record newest first across both kinds, continuing from the last row of the page before", async () => {
    const { log } = await seeded();
    const first = await log.records({ op: "page", query: ALL, pageSize: 2 });
    expect(titles(first)).toEqual(["verify failed", "app started"]);
    expect(first.more).toBe(true);
    expect(first.records[0]).toMatchObject({ kind: "log", level: "error", jobId: "b", text: null, session: log.session });

    const last = first.records.at(-1)!;
    const second = await log.records({
      op: "page",
      query: { ...ALL, after: { time: last.time, kind: last.kind, id: last.id } },
      pageSize: 2,
    });
    expect(titles(second)).toEqual(["scan.symlink-unreadable", "fault"]);
    expect(second.records[0]).toMatchObject({ kind: "job-event", text: "sdk says scan.symlink-unreadable", jobId: "a" });
    expect(second.more).toBe(true);
    const third = await log.records({
      op: "page",
      query: { ...ALL, after: { time: second.records[1]!.time, kind: "job-event", id: second.records[1]!.id } },
      pageSize: 2,
    });
    expect(titles(third)).toEqual(["scan.start"]);
    expect(third.more).toBe(false);
    await log.close();
  });

  it("orders records stamped at the same instant by kind, then id, without losing one between pages", async () => {
    const dir = tempDir();
    const log = createAppLog(path.join(dir, "records.sqlite3"), path.join(dir, "logs"));
    const same = "2000-01-01T00:00:00.000Z";
    for (const name of ["scan.start", "scan.dir", "scan.done"]) log.jobEvent("a", event(same, "info", { event: name }));
    const seen: string[] = [];
    let after: { time: string; kind: "log" | "job-event"; id: number } | null = null;
    for (;;) {
      const page: RecordsPage = await log.records({ op: "page", query: { ...ALL, kind: "job-event", after }, pageSize: 1 });
      seen.push(...titles(page));
      if (!page.more) break;
      const last = page.records[0]!;
      after = { time: last.time, kind: last.kind, id: last.id };
    }
    expect(seen).toEqual(["scan.done", "scan.dir", "scan.start"]);
    await log.close();
  });

  it("filters by launch, kind, level and search", async () => {
    const { log } = await seeded();
    const page = (query: Partial<typeof ALL> | Record<string, unknown>) =>
      log.records({ op: "page", query: { ...ALL, ...query } as never, pageSize: 100 }).then(titles);
    expect(await page({ session: "2026-06-14T05:25:48.123Z" })).toEqual(["scan.symlink-unreadable", "scan.start"]);
    expect(await page({ kind: "log" })).toEqual(["verify failed", "app started"]);
    expect(await page({ kind: "job-event", level: "error" })).toEqual(["fault"]);
    expect(await page({ level: "attention" })).toEqual(["verify failed", "scan.symlink-unreadable", "fault"]);
    expect(await page({ level: "info" })).toEqual(["app started", "scan.start"]);
    // Search reads every stored field, and its % and _ are literal.
    expect(await page({ search: "b.zip" })).toEqual(["verify failed"]);
    expect(await page({ search: "100%" })).toEqual(["fault"]);
    expect(await page({ search: "1_0" })).toEqual([]);
    expect(await page({ search: "  " })).toHaveLength(5);
    await log.close();
  });

  it("returns a record whole, every field as stored, and the launches the records hold", async () => {
    const { log } = await seeded();
    const { records } = await log.records({ op: "page", query: ALL, pageSize: 100 });
    const line = records.find((record) => record.title === "verify failed");
    const fault = records.find((record) => record.title === "fault");
    expect(await log.records({ op: "detail", kind: "log", id: line!.id })).toEqual({
      kind: "log",
      id: line!.id,
      session: "2026-06-15T01:00:00.000Z",
      time: line!.time,
      level: "error",
      message: "verify failed",
      jobId: "b",
      fields: JSON.stringify({ jobId: "b", archive: "/out/b.zip" }),
    });
    const detail = await log.records({ op: "detail", kind: "job-event", id: fault!.id });
    expect(detail).toMatchObject({ kind: "job-event", seq: 1, jobId: "b", event: "fault", level: "error" });
    expect(JSON.parse((detail as { body: string }).body)).toMatchObject({ event: "fault", detail: "100% gone" });
    expect(await log.records({ op: "detail", kind: "log", id: 9999 })).toBeNull();
    expect(await log.records({ op: "sessions" })).toEqual(["2026-06-15T01:00:00.000Z", "2026-06-14T05:25:48.123Z"]);
    await log.close();
  });

  it("signals after each entry the database stored, and not for one that went to the fallback file", async () => {
    const dir = tempDir();
    const stored = createAppLog(path.join(dir, "records.sqlite3"), path.join(dir, "logs"));
    const listener = vi.fn();
    stored.onStored(listener);
    stored.info("one");
    stored.jobEvent("a", event("2000-01-01T00:00:00.000Z", "info", { event: "scan.start" }));
    await stored.close();
    expect(listener).toHaveBeenCalledTimes(2);

    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "a file, not a directory");
    const fallback = createAppLog(path.join(blocker, "records.sqlite3"), path.join(dir, "fallback-logs"));
    const unheard = vi.fn();
    fallback.onStored(unheard);
    fallback.info("lost to the database");
    await fallback.close();
    expect(unheard).not.toHaveBeenCalled();
  });

  it("fails a read the database cannot answer in time, or once it is unavailable or closed", async () => {
    const dir = tempDir();
    const database = path.join(dir, "records.sqlite3");
    const lock = new DatabaseSync(database);
    lock.exec("CREATE TABLE held (x)");
    lock.exec("BEGIN EXCLUSIVE");
    const log = createAppLog(database, path.join(dir, "logs"));
    await expect(log.records({ op: "sessions" }, 200)).rejects.toThrow(/within 200 ms/);
    await log.close(200);
    lock.exec("ROLLBACK");
    lock.close();
    await expect(log.records({ op: "sessions" })).rejects.toThrow(/closed/);

    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "a file, not a directory");
    const unavailable = createAppLog(path.join(blocker, "records.sqlite3"), path.join(dir, "other-logs"));
    await expect(unavailable.records({ op: "sessions" })).rejects.toThrow();
    await unavailable.close();
  });
});

describe("errorInfo", () => {
  it("captures name, message, and stack from an Error", () => {
    const info = errorInfo(new TypeError("boom"));
    expect(info).toMatchObject({ name: "TypeError", message: "boom" });
    expect(typeof info.stack).toBe("string");
  });

  it("survives JSON serialization (a raw Error would not)", () => {
    expect(JSON.stringify(errorInfo(new Error("x")))).toContain("\"message\":\"x\"");
    expect(JSON.stringify(new Error("x"))).toBe("{}");
  });

  it("recurses the cause chain", () => {
    const err = new Error("outer", { cause: new Error("inner") });
    expect((errorInfo(err).cause as Record<string, unknown>).message).toBe("inner");
  });

  it("wraps a non-Error value", () => {
    expect(errorInfo("nope")).toEqual({ value: "nope" });
    expect(errorInfo(42)).toEqual({ value: "42" });
  });

  it("preserves aggregate diagnostics through JSON serialization", async () => {
    const first = new TypeError("query failed", { cause: new Error("query cause") });
    const second = Object.assign(new Error("write failed"), {
      code: "EACCES", path: "/tmp/result.zip", syscall: "rename", token: "sentinel-secret",
    });
    const aggregate = new AggregateError([first, second], "both failed", { cause: first });
    const info = JSON.parse(JSON.stringify(errorInfo(aggregate)));
    expect(info).toMatchObject({ name: "AggregateError", cause: { message: "query failed" }, errors: [
      { name: "TypeError", message: "query failed", stack: expect.any(String), cause: { message: "query cause" } },
      { message: "write failed", stack: expect.any(String), code: "EACCES", path: "/tmp/result.zip", syscall: "rename" },
    ] });

    const dir = tempDir();
    const database = path.join(dir, "records.sqlite3");
    const log = createAppLog(database, path.join(dir, "logs"));
    log.error("operation failed", { error: info });
    await log.close();
    const [row] = rows(database);
    expect(JSON.parse(row?.fields ?? "").error.errors[1]).toMatchObject({ message: "write failed", code: "EACCES" });
  });

  it("contains cycles through aggregate members and causes without losing other failures", () => {
    const aggregate = new AggregateError([], "cyclic");
    aggregate.errors.push(aggregate, new Error("retained", { cause: aggregate }));
    expect(errorInfo(aggregate)).toMatchObject({ errors: [
      { message: "cyclic", circular: true },
      { message: "retained", cause: { message: "cyclic", circular: true } },
    ] });
  });
});
