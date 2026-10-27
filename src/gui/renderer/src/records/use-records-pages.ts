/** Own page requests and their lifetime; failed reads wait for explicit recovery.
 * Loaded rows stay in memory, and the window renders them virtually. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RecordsQuery, RecordSources, RecordSummary } from "../../../shared/records";
import { reportableError } from "../externalDropBoundary";
import { cursorAfter, mergeNewestPage } from "./record-format";

type Filters = Omit<RecordsQuery, "after">;

export function useRecordsPages(filters: Filters) {
  const loaded = useRef<{ records: RecordSummary[]; more: boolean }>({ records: [], more: false });
  const generation = useRef(0);
  // A newest page can reset the loaded range; a continuation read before that cannot apply.
  const range = useRef(0);
  const filtersRef = useRef(filters);
  const live = useRef(true);
  const sourcesRequest = useRef(0);
  const failures = useRef(new Set<string>());
  const newestBusy = useRef(false);
  const moreBusy = useRef(false);
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
      range.current++;
      moreBusy.current = false;
      loaded.current = mergeNewestPage(loaded.current.records, loaded.current.more, page);
      failures.current.delete("list");
      setStatus("ready");
    } catch (error) {
      if (current === generation.current) {
        failed("list", "read the newest records", error);
        if (loaded.current.records.length === 0) setStatus("failed");
      }
    } finally {
      if (current === generation.current) { newestBusy.current = false; changed(); }
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!loaded.current.more || moreBusy.current || failures.current.size > 0) return;
    moreBusy.current = true;
    changed();
    const current = generation.current;
    const layout = range.current;
    const after = cursorAfter(loaded.current.records);
    try {
      const page = await window.zipkit.readRecordsPage({ ...filtersRef.current, after });
      if (current !== generation.current || layout !== range.current) return;
      loaded.current = { records: [...loaded.current.records, ...page.records], more: page.more };
      failures.current.delete("list");
    } catch (error) {
      if (current === generation.current && layout === range.current) failed("list", "read more records", error);
    } finally {
      if (current === generation.current && layout === range.current) { moreBusy.current = false; changed(); }
    }
  }, []);

  // Sources and the newest records recover independently; reading more
  // resumes once the list is current again.
  const retry = useCallback(async () => {
    await Promise.all([readSources(), readNewest()]);
  }, [readSources, readNewest]);

  useEffect(() => {
    const current = ++generation.current;
    filtersRef.current = filters;
    loaded.current = { records: [], more: false };
    const layout = ++range.current;
    newestBusy.current = false;
    moreBusy.current = false;
    failures.current.delete("list");
    setStatus("loading");
    void window.zipkit.readRecordsPage({ ...filters, after: null }).then((page) => {
      if (current !== generation.current || layout !== range.current) return;
      loaded.current = { records: page.records, more: page.more };
      setStatus("ready");
      changed();
    }, (error) => {
      if (current !== generation.current || layout !== range.current) return;
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

  return { records: loaded.current.records, revision, status, sources, stale: failures.current.size > 0,
    loadingMore: moreBusy.current, loadMore, readNewest, retry };
}
