/** Own page requests and their lifetime; failed reads wait for explicit recovery. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RecordsQuery, RecordSources } from "../../../shared/records";
import { reportableError } from "../externalDropBoundary";
import { RecordsCache } from "./records-cache";

type Filters = Omit<RecordsQuery, "after">;

export function useRecordsPages(filters: Filters) {
  const cache = useRef(new RecordsCache());
  const generation = useRef(0);
  const geometry = useRef(0);
  const filtersRef = useRef(filters);
  const live = useRef(true);
  const sourcesRequest = useRef(0);
  const failures = useRef(new Set<string>());
  const fetching = useRef(new Set<number>());
  // Invalidating geometry discards replies, not requests already issued.
  const refetchesInFlight = useRef(0);
  const newestBusy = useRef(false);
  const moreBusy = useRef(false);
  const visible = useRef({ start: 0, end: 0 });
  const [revision, redraw] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [sources, setSources] = useState<RecordSources | null>(null);
  const changed = () => redraw((value) => value + 1);
  const failed = (owner: string, context: string, error: unknown) => {
    const already = failures.current.has(owner);
    failures.current.add(owner);
    if (!already) window.zipkit.reportError(context, reportableError(error));
    changed();
  };
  const readSources = useCallback(async () => {
    const current = ++sourcesRequest.current;
    try {
      const next = await window.zipkit.readRecordSources();
      if (!live.current || current !== sourcesRequest.current) return;
      setSources(next);
      failures.current.delete("sources");
      changed();
    } catch (error) {
      if (live.current && current === sourcesRequest.current) failed("sources", "read the record sources", error);
    }
  }, []);

  const readNewest = useCallback(async () => {
    if (newestBusy.current) return;
    newestBusy.current = true;
    const current = generation.current;
    try {
      const page = await window.zipkit.readRecordsPage({ ...filtersRef.current, after: null });
      if (current !== generation.current) return;
      // Continuations and refetches from the previous geometry cannot apply.
      geometry.current++;
      fetching.current.clear();
      moreBusy.current = false;
      cache.current.newest(page);
      failures.current.delete("list");
      setStatus("ready");
    } catch (error) {
      if (current === generation.current) {
        failed("list", "read the newest records", error);
        if (cache.current.length === 0) setStatus("failed");
      }
    } finally {
      if (current === generation.current) { newestBusy.current = false; changed(); }
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!cache.current.more || moreBusy.current || failures.current.size > 0) return;
    moreBusy.current = true;
    changed();
    const current = generation.current;
    const layout = geometry.current;
    const after = cache.current.segments.at(-1)?.tailCursor ?? null;
    try {
      const page = await window.zipkit.readRecordsPage({ ...filtersRef.current, after });
      if (current !== generation.current || layout !== geometry.current) return;
      cache.current.append(page);
      cache.current.retain(cache.current.segmentAt(visible.current.start));
      failures.current.delete("list");
    } catch (error) {
      if (current === generation.current && layout === geometry.current) failed("list", "read more records", error);
    } finally {
      if (current === generation.current && layout === geometry.current) { moreBusy.current = false; changed(); }
    }
  }, []);

  const readSegment = useCallback(async (index: number, retry = false) => {
    const descriptor = cache.current.segments[index];
    if (!descriptor || cache.current.pages.has(index) || fetching.current.has(index) || refetchesInFlight.current >= 2 || (!retry && failures.current.size > 0)) return;
    const current = generation.current;
    const layout = geometry.current;
    fetching.current.add(index);
    refetchesInFlight.current++;
    try {
      const page = await window.zipkit.readRecordsPage({ ...filtersRef.current, after: descriptor.after });
      if (current !== generation.current || layout !== geometry.current) return;
      cache.current.pages.set(index, page.records.slice(0, descriptor.length));
      cache.current.retain(cache.current.segmentAt(visible.current.start));
      failures.current.delete("list");
    } catch (error) {
      if (current === generation.current && layout === geometry.current) failed("list", "read the visible records", error);
    } finally {
      refetchesInFlight.current--;
      if (current === generation.current && layout === geometry.current) fetching.current.delete(index);
      if (live.current) changed();
    }
  }, []);

  const showRange = useCallback((start: number, end: number) => {
    visible.current = { start, end };
    const first = cache.current.segmentAt(start), last = cache.current.segmentAt(end);
    cache.current.retain(first);
    for (let index = Math.max(0, first); index <= last; index++) void readSegment(index);
  }, [readSegment]);

  const retry = useCallback(async () => {
    // Sources and the failed viewport/newest read recover independently.
    const first = cache.current.segmentAt(visible.current.start), last = cache.current.segmentAt(visible.current.end);
    const missing = first < 0 ? undefined : Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index)
      .find((index) => !cache.current.pages.has(index));
    await Promise.all([readSources(), missing === undefined ? readNewest() : readSegment(missing, true)]);
  }, [readSources, readNewest, readSegment]);

  useEffect(() => {
    const current = ++generation.current;
    filtersRef.current = filters;
    cache.current = new RecordsCache();
    const layout = ++geometry.current;
    newestBusy.current = false;
    fetching.current.clear();
    moreBusy.current = false;
    failures.current.delete("list");
    setStatus("loading");
    void window.zipkit.readRecordsPage({ ...filters, after: null }).then((page) => {
      if (current !== generation.current || layout !== geometry.current) return;
      cache.current.append(page);
      setStatus("ready");
      changed();
    }, (error) => {
      if (current !== generation.current || layout !== geometry.current) return;
      failed("list", "read the records", error);
      setStatus("failed");
    });
    return () => { generation.current++; };
  }, [filters]);

  useEffect(() => {
    live.current = true;
    void readSources();
    return () => { live.current = false; sourcesRequest.current++; };
  }, [readSources]);

  return { cache: cache.current, revision, status, sources, stale: failures.current.size > 0,
    loadingMore: moreBusy.current, loadMore, readNewest, showRange, retry };
}
