import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeManagedTextWithin } from "../../../src/gui/main/managed-write.js";

describe("writeManagedTextWithin", () => {
  it("the actual session-end worker refuses to replace an unreadable queue and leaves it untouched", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zipkit-session-unreadable-"));
    try {
      const file = path.join(root, "queue.json");
      const current = "{ not json";
      writeFileSync(file, current);
      expect(() => writeManagedTextWithin(file, '{"jobs":[]}', 2_000)).toThrow(/is invalid/);
      expect(readFileSync(file, "utf8")).toBe(current);
      expect(readdirSync(root)).toEqual(["queue.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the actual session-end worker preserves the settings no-file default", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zipkit-session-defaults-"));
    try {
      const file = path.join(root, "config.json");
      writeManagedTextWithin(file, "{}", 2_000, undefined, { createAbsent: false });
      expect(readdirSync(root)).toEqual([]);
      writeFileSync(file, '{"theme":"dark"}');
      writeManagedTextWithin(file, "{}", 2_000, undefined, { createAbsent: false });
      expect(readFileSync(file, "utf8")).toBe("{}");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("gives up on a write that does not answer within its bound, and returns", () => {
    // The wait is the OS's own (Atomics.wait), which a fake clock cannot drive; the bound is kept short.
    const silent = new URL("./workers/silent.mjs", import.meta.url);
    const started = performance.now();

    expect(() => writeManagedTextWithin("/unused/queue.json", "{}", 50, silent)).toThrow(/did not finish within 50 ms/);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
