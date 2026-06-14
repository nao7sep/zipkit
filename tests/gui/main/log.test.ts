/**
 * Tests for the app logger's error serializer. The trap it guards against: an
 * Error's own properties are non-enumerable, so logging a raw Error stringifies
 * to `{}` — errorInfo must capture name/message/stack and recurse the cause chain.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAppLog, errorInfo } from "../../../src/gui/main/log.js";

describe("createAppLog", () => {
  it("writes JSON Lines with the envelope, gates debug off by default, and redacts denied keys", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zipkit-log-"));
    const log = createAppLog(dir, new Date("2026-06-14T05:25:48.000Z"));
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
