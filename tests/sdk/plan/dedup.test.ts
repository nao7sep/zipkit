/**
 * Overlap dedup (pass 6), tested directly. A later entry that resolves to the
 * same archive path *and* the same absolute source as an earlier one is the
 * same file reached twice through overlapping inputs: it is collapsed (excluded,
 * not emitted) with an `entry.duplicate` info finding, keeping the first. A
 * shared path with a *different* source is left untouched for the collision pass
 * to treat as an error.
 */

import { describe, expect, it } from "vitest";
import { applyDedup } from "../../../src/sdk/plan/dedup.js";
import { workItem } from "../../helpers/synthetic.js";

describe("applyDedup", () => {
  it("collapses the second of two entries sharing path and source", () => {
    const items = [
      workItem({ archivePath: "a.txt", absolutePath: "/src/a.txt" }),
      workItem({ archivePath: "a.txt", absolutePath: "/src/a.txt" }),
    ];
    applyDedup(items);
    expect(items[0]!.excluded).toBe(false);
    expect(items[0]!.findings).toEqual([]);
    expect(items[1]!.excluded).toBe(true);
    expect(items[1]!.emitExplicit).toBe(false);
    expect(items[1]!.excludeReason).toMatch(/duplicate of the same source/);
    expect(items[1]!.findings.map((f) => f.rule)).toEqual(["entry.duplicate"]);
  });

  it("leaves a shared path with distinct sources for the collision pass", () => {
    const items = [
      workItem({ archivePath: "a.txt", absolutePath: "/one/a.txt" }),
      workItem({ archivePath: "a.txt", absolutePath: "/two/a.txt" }),
    ];
    applyDedup(items);
    expect(items[0]!.excluded).toBe(false);
    expect(items[1]!.excluded).toBe(false);
    expect(items[1]!.findings).toEqual([]);
  });

  it("does not seed the seen-set from an already-excluded entry", () => {
    const items = [
      workItem({ archivePath: "a.txt", absolutePath: "/src/a.txt", excluded: true, excludeReason: "junk" }),
      workItem({ archivePath: "a.txt", absolutePath: "/src/a.txt" }),
    ];
    applyDedup(items);
    // The live entry is the first survivor seen, so it is kept, not collapsed.
    expect(items[1]!.excluded).toBe(false);
    expect(items[1]!.findings).toEqual([]);
  });
});
