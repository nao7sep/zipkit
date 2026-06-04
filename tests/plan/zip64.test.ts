/**
 * Zip64 need estimate (§11). Locks the sentinel boundary: 0xFFFFFFFF and
 * 0xFFFF are reserved markers, not representable values, so they must be
 * compared with `>=`.
 */

import { describe, expect, it } from "vitest";
import { computeZip64Need } from "../../src/plan/zip64.js";
import type { SizedEntry } from "../../src/plan/zip64.js";

function entries(count: number, size = 0): SizedEntry[] {
  return Array.from({ length: count }, (_, i) => ({ name: `f${i}`, size, isDir: false }));
}

describe("computeZip64Need", () => {
  it("needs Zip64 for an entry of exactly the 0xFFFFFFFF sentinel size", () => {
    expect(computeZip64Need([{ name: "big", size: 0xffffffff, isDir: false }])).toBe(true);
  });

  it("does not need Zip64 for a small archive", () => {
    expect(computeZip64Need([{ name: "small", size: 1000, isDir: false }])).toBe(false);
  });

  it("needs Zip64 once the entry count reaches the 0xFFFF sentinel", () => {
    expect(computeZip64Need(entries(0xffff))).toBe(true);
    expect(computeZip64Need(entries(0xfffe))).toBe(false);
  });
});
