/**
 * `messageFor` derives the envelope's human-readable line from a typed event
 * body. Every variant must render a non-empty string; counts pluralize; a fault
 * folds in its cause when present.
 */

import { describe, expect, it } from "vitest";
import { messageFor } from "../../src/log/messages.ts";
import { resolvePolicy } from "../../src/policy.ts";
import type { LogEventBody } from "../../src/types.ts";

const startup = { event: "session.start", version: "1.0.0", chunkSize: 65536, debug: false, policy: resolvePolicy(undefined, undefined) } as const;
const error = { name: "ZipKitError", code: "archive.not-zip", kind: "invalid", effect: "none", message: "not a zip" } as const;

const samples: LogEventBody[] = [
  startup,
  { event: "scan.start", inputs: 2 },
  { event: "scan.dir", path: "a/b" },
  { event: "scan.done", entries: 3, prunedDirs: 1 },
  { event: "plan.done", total: 3, included: 2, excluded: 1, renamed: 0, warnings: 0, errors: 0, writable: true },
  { event: "entry.excluded", path: "x", reason: "pattern .DS_Store" },
  { event: "entry.renamed", path: "a", from: "à" },
  { event: "entry.flagged", rule: "name.nfd", path: "p", severity: "info" },
  { event: "write.start", entries: 1 },
  { event: "entry.written", path: "p" },
  { event: "write.done", bytes: 100, zip64: false },
  { event: "verify.start", entries: 2 },
  { event: "entry.verified", path: "p" },
  { event: "verify.done", total: 2, crc32Failed: 0, unreadable: 0, localMismatched: 0, sha256Mismatched: 0, manifestMismatched: 0, ok: true },
  { event: "fault", error },
];

describe("messageFor", () => {
  it("produces a non-empty string for every event variant", () => {
    for (const body of samples) {
      const message = messageFor(body);
      expect(message).toBeTypeOf("string");
      expect(message.length).toBeGreaterThan(0);
    }
  });

  // The wording is a diagnostic, free to change; what a line must carry is pinned.
  it("carries a fault's code and message, and the message of what caused it", () => {
    const m = messageFor({ event: "fault", error: { ...error, cause: { name: "Error", message: "ENOENT" } } });
    for (const part of ["archive.not-zip", "not a zip", "ENOENT"]) expect(m).toContain(part);
  });

  it("notes zip64 only when present", () => {
    expect(messageFor({ event: "write.done", bytes: 10, zip64: true })).toContain("(zip64)");
    expect(messageFor({ event: "write.done", bytes: 10, zip64: false })).not.toContain("zip64");
  });

  it("tells a verification with problems from a clean one", () => {
    const clean = { event: "verify.done", total: 2, crc32Failed: 0, unreadable: 0, localMismatched: 0, sha256Mismatched: 0, manifestMismatched: 0, ok: true } as const;
    expect(messageFor(clean)).not.toBe(messageFor({ ...clean, crc32Failed: 1, unreadable: 1, ok: false }));
  });

  it("renders the startup line with the version and runtime config", () => {
    const m = messageFor(startup);
    for (const part of ["1.0.0", "65536"]) expect(m).toContain(part);
    expect(m).not.toContain("debug");
    expect(messageFor({ ...startup, debug: true })).toContain("debug");
  });
});
