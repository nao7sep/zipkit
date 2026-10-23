// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRecordsPages } from "../../../../src/gui/renderer/src/records/use-records-pages";
import type { RecordSummary, RecordsQuery, RecordsPage } from "../../../../src/gui/shared/records";

const filters = { session: null, kind: null, level: null, search: "" };
const records: RecordSummary[] = Array.from({ length: 1200 }, (_, index) => ({
  kind: "log", id: 1200 - index, time: "2026-10-01T00:00:00Z", session: "2026-10-01T00:00:00Z",
  title: `Record ${1200 - index}`, level: "info", text: null, jobId: null,
}));
const page = (query: RecordsQuery): RecordsPage => {
  const start = query.after ? records.findIndex((row) => row.id === query.after!.id) + 1 : 0;
  return { records: records.slice(start, start + 100), more: start + 100 < records.length };
};
function setup() {
  const readRecordsPage = vi.fn(async (query: RecordsQuery) => page(query));
  const readRecordSources = vi.fn(async () => ({ currentSession: records[0]!.session, sessions: [records[0]!.session] }));
  const reportError = vi.fn();
  Object.defineProperty(window, "zipkit", { configurable: true, value: { readRecordsPage, readRecordSources, reportError } });
  const hook = renderHook(() => useRecordsPages(filters));
  return { ...hook, readRecordsPage, readRecordSources, reportError };
}
afterEach(cleanup);

describe("useRecordsPages", () => {
  it("traverses beyond five pages with bounded bodies and refetches an evicted page from its saved cursor", async () => {
    const hook = setup();
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    for (let segment = 1; segment < 10; segment++) {
      await act(async () => { await hook.result.current.loadMore(); });
      await act(async () => hook.result.current.showRange(segment * 100, segment * 100 + 10));
      expect([...hook.result.current.cache.pages.values()].flat().length).toBeLessThanOrEqual(500);
    }
    expect(hook.result.current.cache.length).toBe(1000);
    expect(hook.result.current.cache.pages.has(1)).toBe(false);
    await act(async () => hook.result.current.showRange(100, 110));
    await waitFor(() => expect(hook.result.current.cache.row(100)?.id).toBe(1100));
    expect(hook.readRecordsPage).toHaveBeenLastCalledWith({ ...filters, after: { time: records[99]!.time, kind: "log", id: 1101 } });
    expect([...hook.result.current.cache.pages.values()].flat().length).toBeLessThanOrEqual(500);
  });

  it("limits missing-page requests to two and applies only the requested descriptor length", async () => {
    const hook = setup();
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    for (let segment = 1; segment < 10; segment++) {
      await act(async () => { await hook.result.current.loadMore(); });
      await act(async () => hook.result.current.showRange(segment * 100, segment * 100));
    }
    const pending: { query: RecordsQuery; resolve: (page: RecordsPage) => void }[] = [];
    hook.readRecordsPage.mockImplementation((query) => new Promise((resolve) => pending.push({ query, resolve })));
    await act(async () => hook.result.current.showRange(100, 450));
    expect(pending).toHaveLength(2);
    await act(async () => pending[0]!.resolve({ records: [...page(pending[0]!.query).records, ...records.slice(200, 220)], more: true }));
    expect(hook.result.current.cache.pages.get(1)).toHaveLength(100);
    await act(async () => pending[1]!.resolve(page(pending[1]!.query)));
    expect([...hook.result.current.cache.pages.values()].flat().length).toBeLessThanOrEqual(500);
  });

  it("keeps a failed visible-page read stale without loops and retries it together with sources", async () => {
    const hook = setup();
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    for (let segment = 1; segment < 9; segment++) {
      await act(async () => { await hook.result.current.loadMore(); });
      await act(async () => hook.result.current.showRange(segment * 100, segment * 100));
    }
    hook.readRecordsPage.mockRejectedValueOnce(new Error("offline"));
    await act(async () => hook.result.current.showRange(100, 110));
    await waitFor(() => expect(hook.result.current.stale).toBe(true));
    const reads = hook.readRecordsPage.mock.calls.length;
    await act(async () => hook.result.current.showRange(100, 110));
    expect(hook.readRecordsPage).toHaveBeenCalledTimes(reads);
    expect(hook.reportError).toHaveBeenCalledOnce();
    await act(async () => { await hook.result.current.retry(); });
    expect(hook.result.current.stale).toBe(false);
    expect(hook.result.current.cache.row(100)?.id).toBe(1100);
    expect(hook.readRecordSources).toHaveBeenCalledTimes(2);
  });

  it("retains refetch slots until obsolete requests settle after a newest refresh", async () => {
    const hook = setup();
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    for (let segment = 1; segment < 10; segment++) {
      await act(async () => { await hook.result.current.loadMore(); });
      await act(async () => hook.result.current.showRange(segment * 100, segment * 100));
    }
    const pending: { query: RecordsQuery; resolve: (page: RecordsPage) => void }[] = [];
    hook.readRecordsPage.mockImplementation((query) => query.after
      ? new Promise((resolve) => pending.push({ query, resolve }))
      : Promise.resolve(page(query)));
    await act(async () => hook.result.current.showRange(100, 450));
    expect(pending).toHaveLength(2);
    await act(async () => { await hook.result.current.readNewest(); });
    await act(async () => hook.result.current.showRange(100, 450));
    expect(pending).toHaveLength(2);
    await act(async () => pending[0]!.resolve(page(pending[0]!.query)));
    expect(hook.result.current.cache.pages.has(1)).toBe(false);
    await act(async () => hook.result.current.showRange(100, 450));
    expect(pending).toHaveLength(3);
    await act(async () => {
      pending[1]!.resolve(page(pending[1]!.query));
      pending[2]!.resolve(page(pending[2]!.query));
    });
    expect(hook.result.current.cache.row(100)?.id).toBe(1100);
  });
});
