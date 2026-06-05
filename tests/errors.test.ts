/**
 * Error classification: the usage-vs-runtime split and the exit-code mapping.
 * Attribution rides on each error's `usage` flag (set at the throw site, not
 * inferred from the code string), and both `isUsageFault` and `exitCodeFor` read
 * it — so the exit code and the report-vs-rethrow decision can never diverge.
 */

import { describe, expect, it } from "vitest";
import {
  AbortError,
  exitCodeFor,
  isUsageFault,
  PolicyError,
  ReadError,
  ScanError,
  WriteError,
} from "../src/errors.js";

describe("usage classification", () => {
  it("treats every PolicyError as a usage fault (exit 2)", () => {
    const err = new PolicyError("spec.invalid", "bad spec");
    expect(err.usage).toBe(true);
    expect(isUsageFault(err)).toBe(true);
    expect(exitCodeFor(err)).toBe(2);
  });

  it("treats a scan/read error flagged usage as a usage fault (exit 2)", () => {
    for (const err of [
      new ScanError("scan.input-missing", "x", { usage: true }),
      new ReadError("read.open-failed", "y", { usage: true }),
      new ReadError("read.no-dest", "z", { usage: true }),
    ]) {
      expect(err.usage).toBe(true);
      expect(isUsageFault(err)).toBe(true);
      expect(exitCodeFor(err)).toBe(2);
    }
  });

  it("treats an unflagged scan/write/read error as a runtime fault, coded by domain", () => {
    expect(exitCodeFor(new ScanError("scan.read-failed", "x"))).toBe(3);
    expect(exitCodeFor(new WriteError("write.failed", "x"))).toBe(4);
    const read = new ReadError("read.not-zip", "x");
    expect(read.usage).toBe(false);
    expect(isUsageFault(read)).toBe(false);
    expect(exitCodeFor(read)).toBe(5);
  });

  it("maps cancellation to 130 and is never a usage fault", () => {
    const err = new AbortError();
    expect(isUsageFault(err)).toBe(false);
    expect(exitCodeFor(err)).toBe(130);
  });

  it("maps an arbitrary thrown value to 1 and not a usage fault", () => {
    expect(isUsageFault(new Error("boom"))).toBe(false);
    expect(isUsageFault("nope")).toBe(false);
    expect(exitCodeFor(new Error("boom"))).toBe(1);
    expect(exitCodeFor("nope")).toBe(1);
  });
});
