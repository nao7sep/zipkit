/**
 * Zip64 need estimate. Locks the sentinel boundary: 0xFFFFFFFF and
 * 0xFFFF are reserved markers, not representable values, so they must be
 * compared with `>=`.
 */

import { describe, expect, it } from "vitest";
import { computeZip64Need, deflateBound, planNeedsZip64 } from "../../../src/sdk/plan/zip64.js";
import type { MetadataContent, SizedEntry } from "../../../src/sdk/plan/zip64.js";
import { resolvePolicy } from "../../../src/sdk/policy.js";
import type { WriteEntry } from "../../../src/sdk/internal/types.js";

function entries(count: number, size = 0): SizedEntry[] {
  return Array.from({ length: count }, (_, i) => ({ name: `f${i}`, size, isDir: false }));
}

function fileEntry(size: number, method: "store" | "deflate"): WriteEntry {
  return {
    archivePath: "f.bin",
    originalPath: "f.bin",
    sourcePath: "f.bin",
    type: "file",
    method,
    absolutePath: "/abs/f.bin",
    size,
    mtimeNs: 0n,
    atimeNs: 0n,
    ctimeNs: 0n,
    birthtimeNs: 0n,
    mode: 0o644,
    transformations: [],
  };
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

  it("counts the always-written timestamp extras at the 4 GiB boundary", () => {
    // A single ~4 GiB stored entry whose fixed header and payload alone sit just
    // under the 32-bit limit, but cross it once the per-record timestamp extras
    // the writer always emits are added. Without counting those extras the dry
    // run would report `false` while the real write emits Zip64 — a false
    // compatibility signal. The margin (150 bytes) is within the extras' reach
    // (~98 bytes/record) but the entry itself stays below the per-entry sentinel.
    const size = 0xffffffff - 150;
    expect(size).toBeLessThan(0xffffffff); // not an individually-triggering entry
    expect(computeZip64Need([{ name: "a.bin", size, isDir: false }])).toBe(true);
  });
});

describe("deflateBound", () => {
  it("never underestimates and accounts for stored-block expansion", () => {
    expect(deflateBound(0)).toBe(13);
    expect(deflateBound(1000)).toBeGreaterThan(1000);
    // A near-4 GiB payload can exceed the 32-bit limit once expansion is added.
    expect(deflateBound(0xffffffff - 1000)).toBeGreaterThan(0xffffffff);
  });
});

describe("planNeedsZip64", () => {
  it("accounts for deflate expansion: a deflate entry needs Zip64 where the same-size store entry does not", () => {
    // Below the per-entry sentinel, so only the method's payload bound decides.
    const size = 0xffffffff - 1000;
    const policy = resolvePolicy(undefined, { metadata: false }); // isolate from the manifest entry
    const stored: MetadataContent = { entries: [fileEntry(size, "store")], excluded: [], findings: [] };
    const deflated: MetadataContent = { entries: [fileEntry(size, "deflate")], excluded: [], findings: [] };
    expect(planNeedsZip64(stored, policy)).toBe(false);
    expect(planNeedsZip64(deflated, policy)).toBe(true);
  });
});
