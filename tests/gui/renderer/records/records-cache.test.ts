import { describe, expect, it } from "vitest";
import { RecordsCache } from "../../../../src/gui/renderer/src/records/records-cache";
import type { RecordSummary } from "../../../../src/gui/shared/records";

function rows(start: number, count = 100): RecordSummary[] {
  return Array.from({ length: count }, (_, index) => ({ kind: "log", id: start - index,
    session: "2026-10-01T00:00:00Z", time: "2026-10-01T00:00:00Z", level: "info", title: `row ${start - index}`, text: null, jobId: null }));
}

describe("RecordsCache", () => {
  it("keeps cursor descriptors for a long traversal while retaining at most 500 row bodies", () => {
    const cache = new RecordsCache();
    for (let page = 0; page < 30; page++) {
      cache.append({ records: rows(3000 - page * 100), more: page < 29 });
      cache.retain(page);
      expect(cache.pages.size).toBeLessThanOrEqual(5);
      expect([...cache.pages.values()].reduce((count, page) => count + page.length, 0)).toBeLessThanOrEqual(500);
      expect(cache.pages.has(0)).toBe(true);
    }
    expect(cache.length).toBe(3000);
    expect(cache.segments).toHaveLength(30);
    expect(cache.pages.has(1)).toBe(false);
    expect(cache.segments[1]!.after).toEqual({ time: "2026-10-01T00:00:00Z", kind: "log", id: 2901 });
    expect(cache.row(2999)?.id).toBe(1);
    expect(cache.row(100)).toBeUndefined();
  });

  it("splits repeated overlapping newest merges and shifts older cached segments without losing their cursors", () => {
    const cache = new RecordsCache();
    cache.append({ records: rows(1000), more: true });
    cache.append({ records: rows(900), more: true });
    const olderCursor = cache.segments[1]!.after;
    for (let burst = 1; burst <= 12; burst++) {
      cache.newest({ records: rows(1000 + burst * 30), more: true });
      expect(cache.segments.every((segment) => segment.length <= 100)).toBe(true);
      expect([...cache.pages.values()].reduce((count, page) => count + page.length, 0)).toBeLessThanOrEqual(500);
      expect(cache.row(0)?.id).toBe(1000 + burst * 30);
    }
    expect(cache.length).toBe(560);
    expect(cache.segments.at(-1)!.after).toEqual(olderCursor);
    expect(cache.segments.at(-1)!.tailCursor?.id).toBe(801);
  });

  it("resets a disjoint newest range so its continuation cannot skip a gap", () => {
    const cache = new RecordsCache();
    cache.append({ records: rows(1000), more: true });
    cache.append({ records: rows(900), more: true });
    cache.newest({ records: rows(2000), more: true });
    expect(cache.length).toBe(100);
    expect(cache.pages.size).toBe(1);
    expect(cache.segments[0]!.tailCursor?.id).toBe(1901);
  });
});
