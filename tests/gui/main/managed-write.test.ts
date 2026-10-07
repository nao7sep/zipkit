import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeManagedTextWithin } from "../../../src/gui/main/managed-write.js";

describe("writeManagedTextWithin", () => {
  it("the actual session-end worker refuses a newer queue without touching it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zipkit-session-marker-"));
    try {
      const file = path.join(root, "queue.json");
      const current = '{"formatVersion":2,"kept":true}';
      writeFileSync(file, current);
      expect(() => writeManagedTextWithin(file, '{"formatVersion":1,"jobs":[]}', 2_000)).toThrow(/newer than this build/);
      expect(readFileSync(file, "utf8")).toBe(current);
      expect(readdirSync(root)).toEqual(["queue.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives up on a write that does not answer within its bound, and returns", () => {
    // The wait is the OS's own (Atomics.wait), which a fake clock cannot drive; the bound is kept short.
    const silent = new URL("./workers/silent.mjs", import.meta.url);
    const started = performance.now();

    expect(() => writeManagedTextWithin("/unused/queue.json", "{}", 50, silent)).toThrow(/did not finish within 50 ms/);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
