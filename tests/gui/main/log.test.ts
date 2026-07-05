/**
 * Tests for the app logger's error serializer. The trap it guards against: an
 * Error's own properties are non-enumerable, so logging a raw Error stringifies
 * to `{}` — errorInfo must capture name/message/stack and recurse the cause chain.
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAppLog, errorInfo } from "../../../src/gui/main/log.js";

describe("createAppLog", () => {
  it("writes JSON Lines with the envelope, gates debug off by default, and redacts denied keys", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zipkit-log-"));
    const log = createAppLog(dir, new Date("2026-06-14T05:25:48.123Z"));
    // Millisecond precision (`-fff`): a session log is machine-paced, per the timestamp conventions.
    expect(path.basename(log.path)).toBe("20260614-052548-123-utc.log");
    log.info("hello", { jobId: "a", password: "hunter2" });
    log.debug("noise"); // gated off — no ZIPKIT_DEBUG
    log.error("bad", { code: 7 });

    const [infoLine, errorLine, ...rest] = readFileSync(log.path, "utf8").trim().split("\n");
    expect(rest).toHaveLength(0); // debug omitted -> exactly two lines
    const first = JSON.parse(infoLine ?? "") as Record<string, unknown>;
    expect(first).toMatchObject({ level: "info", message: "hello", jobId: "a" });
    expect(first.password).toBe("[redacted]"); // denied key value replaced
    expect(first.time).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/); // UTC ISO-8601 ms + Z
    expect(JSON.parse(errorLine ?? "")).toMatchObject({ level: "error", message: "bad", code: 7 });
  });

  it("never throws and keeps the message when a field cannot be JSON-serialized (e.g. a BigInt)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zipkit-log-"));
    const log = createAppLog(dir, new Date("2026-06-14T05:25:48.123Z"));

    expect(() => log.info("hello", { big: 10n })).not.toThrow();

    const [line] = readFileSync(log.path, "utf8").trim().split("\n");
    const parsed = JSON.parse(line ?? "") as Record<string, unknown>;
    expect(parsed.message).toBe("hello"); // message survives even though `big` could not serialize
    expect(parsed.level).toBe("info");
    expect(typeof parsed.error).toBe("string"); // the serialization failure is itself surfaced
  });

  it("keeps the real message when a caller field is named `message` (the envelope always wins)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zipkit-log-"));
    const log = createAppLog(dir, new Date("2026-06-14T05:25:48.123Z"));

    log.info("the real message", { message: "spoofed by caller" });

    const [line] = readFileSync(log.path, "utf8").trim().split("\n");
    const parsed = JSON.parse(line ?? "") as Record<string, unknown>;
    expect(parsed.message).toBe("the real message"); // envelope wins; caller's `message` field is shadowed
  });

  it("degrades to the console instead of interleaving when the session file already exists", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zipkit-log-"));
    const now = new Date("2026-06-14T05:25:48.123Z");
    const expectedPath = path.join(dir, "20260614-052548-123-utc.log");
    // Simulate a same-millisecond clash: another process already claimed this exact file.
    writeFileSync(expectedPath, "first-process-line\n");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const log = createAppLog(dir, now);
    log.info("second process");

    // The first process's session file is untouched — no interleaved second session.
    expect(readFileSync(expectedPath, "utf8")).toBe("first-process-line\n");
    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
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
});
