/**
 * Timestamp pass (pass 9), tested directly at both DOS bounds. A modification
 * time whose wall clock in the writer's zone is before 1980 raises
 * `time.pre-1980`; one after 2107 raises `time.post-2107`; an in-range time is
 * silent. The range is judged in the zone the writer renders the DOS field in,
 * so the same instant can be in range in one zone and out of it in another.
 */

import { describe, expect, it } from "vitest";
import { applyTimestamps } from "../../../src/sdk/plan/timestamps.js";
import { workItem, Y2020_NS } from "../../helpers/synthetic.js";

function rules(item: ReturnType<typeof workItem>): string[] {
  return item.findings.map((f) => f.rule);
}

function ns(ms: number): bigint {
  return BigInt(ms) * 1_000_000n;
}

const FLOOR = ns(Date.UTC(1980, 0, 1));
const LIMIT = ns(Date.UTC(2108, 0, 1));

function check(mtimeNs: bigint, timeZone = "UTC"): string[] {
  const items = [workItem({ archivePath: "a.txt", mtimeNs })];
  applyTimestamps(items, timeZone);
  return rules(items[0]!);
}

describe("applyTimestamps", () => {
  it("is silent for an in-range time", () => {
    expect(check(Y2020_NS)).toEqual([]);
  });

  it("flags a time below the 1980 floor as time.pre-1980", () => {
    expect(check(0n)).toEqual(["time.pre-1980"]);
  });

  it("treats the 1980 floor itself as in range (inclusive lower bound)", () => {
    expect(check(FLOOR)).toEqual([]);
  });

  it("flags a time at the DOS limit as time.post-2107 (exclusive upper bound)", () => {
    expect(check(LIMIT)).toEqual(["time.post-2107"]);
  });

  it("treats just below the DOS limit as in range", () => {
    expect(check(LIMIT - 1n)).toEqual([]);
  });

  it("judges the floor in the writer's zone, not UTC", () => {
    // 1980-01-01T00:00Z is 1979-12-31 16:00 in Los Angeles: the writer clamps it.
    expect(check(FLOOR, "America/Los_Angeles")).toEqual(["time.pre-1980"]);
    // 1979-12-31T20:00Z is 1980-01-01 05:00 in Tokyo: the writer keeps it.
    expect(check(ns(Date.UTC(1979, 11, 31, 20)), "Asia/Tokyo")).toEqual([]);
  });

  it("judges the ceiling in the writer's zone, not UTC", () => {
    // 2107-12-31T23:00Z is 2108-01-01 08:00 in Tokyo: the writer clamps it.
    expect(check(ns(Date.UTC(2107, 11, 31, 23)), "Asia/Tokyo")).toEqual(["time.post-2107"]);
    // 2108-01-01T03:00Z is 2107-12-31 19:00 in Los Angeles: the writer keeps it.
    expect(check(ns(Date.UTC(2108, 0, 1, 3)), "America/Los_Angeles")).toEqual([]);
  });

  it("skips excluded entries", () => {
    const items = [workItem({ archivePath: "a.txt", mtimeNs: 0n, excluded: true, excludeReason: "x" })];
    applyTimestamps(items, "UTC");
    expect(items[0]!.findings).toEqual([]);
  });
});
