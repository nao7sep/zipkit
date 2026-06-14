/**
 * `messageFor` derives the envelope's human-readable line from a typed event
 * body. Every variant must render a non-empty string; counts pluralize; a fault
 * folds in its cause when present.
 */

import { describe, expect, it } from "vitest";
import { messageFor } from "../../src/log/messages.js";
import type { LogEventBody } from "../../src/types.js";

const samples: LogEventBody[] = [
  { event: "session.start", version: "0.1.0", concurrency: 8, chunkSize: 65536 },
  { event: "scan.start", inputs: 2 },
  { event: "scan.dir", path: "a/b" },
  { event: "scan.done", entries: 3, prunedDirs: 1 },
  { event: "plan.done", total: 3, included: 2, excluded: 1, renamed: 0, warnings: 0, errors: 0, writable: true },
  { event: "entry.excluded", path: "x", reason: "junk" },
  { event: "entry.renamed", path: "a", from: "à" },
  { event: "entry.flagged", rule: "name.nfd", path: "p", severity: "info" },
  { event: "write.start", entries: 1 },
  { event: "entry.written", path: "p" },
  { event: "write.done", bytes: 100, zip64: false },
  { event: "extract.start", entries: 2, write: true },
  { event: "entry.verified", path: "p" },
  { event: "extract.done", total: 2, crcFailed: 0, shaMismatched: 0, written: 2, skipped: 0, reportOk: true },
  { event: "fault", code: "read.not-zip", detail: "not a zip" },
];

describe("messageFor", () => {
  it("produces a non-empty string for every event variant", () => {
    for (const body of samples) {
      const message = messageFor(body);
      expect(message).toBeTypeOf("string");
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it("pluralizes counts (1 vs N)", () => {
    expect(messageFor({ event: "scan.start", inputs: 1 })).toBe("scanning 1 input");
    expect(messageFor({ event: "scan.start", inputs: 2 })).toBe("scanning 2 inputs");
    expect(messageFor({ event: "write.start", entries: 1 })).toBe("writing 1 entry");
    expect(messageFor({ event: "write.start", entries: 3 })).toBe("writing 3 entries");
  });

  it("renders a fault with and without a cause", () => {
    expect(messageFor({ event: "fault", code: "x.y", detail: "boom" })).toBe("x.y: boom");
    expect(messageFor({ event: "fault", code: "x.y", detail: "boom", cause: "ENOENT" })).toBe(
      "x.y: boom: ENOENT",
    );
  });

  it("notes zip64 only when present", () => {
    expect(messageFor({ event: "write.done", bytes: 10, zip64: true })).toContain("(zip64)");
    expect(messageFor({ event: "write.done", bytes: 10, zip64: false })).not.toContain("zip64");
  });

  it("distinguishes extract from verify by the write flag", () => {
    expect(messageFor({ event: "extract.start", entries: 1, write: true })).toContain("extracting");
    expect(messageFor({ event: "extract.start", entries: 1, write: false })).toContain("verifying");
  });

  it("renders the startup line with the version and runtime config", () => {
    const m = messageFor({ event: "session.start", version: "0.1.0", concurrency: 8, chunkSize: 65536 });
    expect(m).toContain("0.1.0");
    expect(m).toContain("8");
    expect(m).toContain("65536");
  });
});
