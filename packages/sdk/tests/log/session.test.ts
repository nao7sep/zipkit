/**
 * The per-session log file: its seconds stamp plus a random id (the timestamp
 * convention's form for concurrent creators in one folder), exclusive creation,
 * synchronous JSON-Lines writes, and the non-fatal silent degrade when the file
 * cannot be opened.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileTimestamp, openSessionLog, sessionLogName } from "../../../src/sdk/log/session.js";
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

describe("session log names", () => {
  it("stamps to the second in UTC", () => {
    expect(fileTimestamp(new Date("2026-06-10T03:15:42.123Z"))).toBe("20260610-031542-utc");
    expect(fileTimestamp()).toMatch(/^\d{8}-\d{6}-utc$/);
  });

  it("follows the stamp with a lowercase random id, distinct for runs started in the same second", () => {
    const now = new Date("2026-06-10T03:15:42.123Z");
    expect(sessionLogName(now, "abc123")).toBe("20260610-031542-utc-abc123.log");
    const names = new Set(Array.from({ length: 50 }, () => sessionLogName(now)));
    expect(names.size).toBe(50);
    for (const name of names) expect(name).toMatch(/^20260610-031542-utc-[0-9a-z]{12}\.log$/);
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

  it("never appends into a file another run already created", async () => {
    const file = path.join(dir, "taken.log");
    await writeFile(file, "another run's line\n");
    const log = openSessionLog(file);
    log.sink(event("info", "mine"));
    expect(await readFile(file, "utf8")).toBe("another run's line\n");
  });

  it("degrades silently — no stderr, no throw — when the file cannot be opened", async () => {
    // Make the log's parent a regular file so mkdir/open fails (ENOTDIR).
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "x");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const log = openSessionLog(path.join(blocker, "nested", "s.log"));
    expect(() => log.sink(event("error", "after open failed"))).not.toThrow();

    // An SDK never falls back to a standard stream (§4): the dead file sink is a
    // silent no-op, and the live progress seam (a separate sink) carries events.
    expect(stderr).not.toHaveBeenCalled();
  });
});
