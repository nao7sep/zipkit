/**
 * Timestamp pass (pass 9), tested directly at both DOS bounds. A modification
 * time below the 1980 floor raises `time.pre-1980`; at or above the 2108 limit
 * raises `time.post-2107`; an in-range time is silent. The bounds are asymmetric
 * by construction — the floor is inclusive, the limit exclusive — so they are
 * pinned exactly.
 */

import { describe, expect, it } from "vitest";
import { DOS_EPOCH_NS, DOS_LIMIT_NS } from "../../../src/sdk/internal/dosTime.js";
import { applyTimestamps } from "../../../src/sdk/plan/timestamps.js";
import { workItem, Y2020_NS } from "../../helpers/synthetic.js";

function rules(item: ReturnType<typeof workItem>): string[] {
  return item.findings.map((f) => f.rule);
}

describe("applyTimestamps", () => {
  it("is silent for an in-range time", () => {
    const items = [workItem({ archivePath: "a.txt", mtimeNs: Y2020_NS })];
    applyTimestamps(items);
    expect(items[0]!.findings).toEqual([]);
  });

  it("flags a time below the 1980 floor as time.pre-1980", () => {
    const items = [workItem({ archivePath: "a.txt", mtimeNs: 0n })];
    applyTimestamps(items);
    expect(rules(items[0]!)).toEqual(["time.pre-1980"]);
  });

  it("treats the 1980 floor itself as in range (inclusive lower bound)", () => {
    const items = [workItem({ archivePath: "a.txt", mtimeNs: DOS_EPOCH_NS })];
    applyTimestamps(items);
    expect(items[0]!.findings).toEqual([]);
  });

  it("flags a time at the DOS limit as time.post-2107 (exclusive upper bound)", () => {
    const items = [workItem({ archivePath: "a.txt", mtimeNs: DOS_LIMIT_NS })];
    applyTimestamps(items);
    expect(rules(items[0]!)).toEqual(["time.post-2107"]);
  });

  it("treats just below the DOS limit as in range", () => {
    const items = [workItem({ archivePath: "a.txt", mtimeNs: DOS_LIMIT_NS - 1n })];
    applyTimestamps(items);
    expect(items[0]!.findings).toEqual([]);
  });

  it("skips excluded entries", () => {
    const items = [workItem({ archivePath: "a.txt", mtimeNs: 0n, excluded: true, excludeReason: "x" })];
    applyTimestamps(items);
    expect(items[0]!.findings).toEqual([]);
  });
});
