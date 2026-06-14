/**
 * The per-session log file: the `-fff` millisecond filename stamp (the timestamp
 * convention's exception for concurrent tools), synchronous JSON-Lines writes,
 * and the non-fatal stderr fallback when the file cannot be opened.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSessionTimestamp, openSessionLog } from "../../../src/sdk/log/session.js";
import type { LogEvent } from "../../../src/sdk/types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zipkit-session-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** A minimal but well-typed event for feeding the sink. */
function event(level: LogEvent["level"], message: string): LogEvent {
  return { time: "2026-06-10T03:15:42.123Z", level, message, stage: "scan", event: "scan.start", inputs: 1 };
}

describe("defaultSessionTimestamp", () => {
  it("is yyyymmdd-hhmmss-fff-utc (the millisecond -fff exception)", () => {
    expect(defaultSessionTimestamp(new Date("2026-06-10T03:15:42.123Z"))).toBe("20260610-031542-123-utc");
  });

  it("reads the clock and matches the strict shape when no date is given", () => {
    expect(defaultSessionTimestamp()).toMatch(/^\d{8}-\d{6}-\d{3}-utc$/);
  });
});

describe("openSessionLog", () => {
  it("appends one JSON object per line", async () => {
    const file = path.join(dir, "s.log");
    const log = openSessionLog(file);
    log.sink(event("info", "first"));
    log.sink(event("info", "second"));

    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ message: "first", event: "scan.start" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ message: "second" });
  });

  it("degrades to stderr without throwing when the file cannot be opened", async () => {
    // Make the log's parent a regular file so mkdir/open fails (ENOTDIR).
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "x");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const log = openSessionLog(path.join(blocker, "nested", "s.log"));
    expect(() => log.sink(event("error", "after open failed"))).not.toThrow();

    const written = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("session log unavailable"); // surfaced, not swallowed
    expect(written).toContain("after open failed"); // the line fell back to stderr
  });
});
