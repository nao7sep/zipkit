/** Own page requests and their lifetime; failed reads wait for explicit recovery.
 * Loaded rows stay in memory, and the window renders them virtually. The window
 * has one list read at a time: a newer read aborts the one in flight, and a
 * continuation waits until no read is in flight. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RecordsQuery, RecordSources, RecordSummary } from "../../../shared/records";
import { reportableError } from "../externalDropBoundary";
import { cursorAfter, mergeNewestPage } from "./record-format";

type Filters = Omit<RecordsQuery, "after">;

export function useRecordsPages(filters: Filters) {
  const loaded = useRef<{ records: RecordSummary[]; more: boolean }>({ records: [], more: false });
  const filtersRef = useRef(filters);
  const reader = useRef<{ kind: "newest" | "more"; aborter: AbortController } | null>(null);
  const sourcesReader = useRef<AbortController | null>(null);
  const failures = useRef(new Set<string>());
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
  /** Take the window's one list read, aborting the one in flight. */
  const begin = (kind: "newest" | "more"): AbortSignal => {
    reader.current?.aborter.abort();
    const aborter = new AbortController();
    reader.current = { kind, aborter };
    return aborter.signal;
  };
  const end = (signal: AbortSignal) => {
    if (signal.aborted) return;
    reader.current = null;
    changed();
  };

  const readSources = useCallback(async () => {
    sourcesReader.current?.abort();
    const aborter = new AbortController();
    sourcesReader.current = aborter;
    try {
      const next = await window.zipkit.readRecordSources();
      if (aborter.signal.aborted) return;
      setSources(next);
      failures.current.delete("sources");
      changed();
    } catch (error) {
      if (!aborter.signal.aborted) failed("sources", "read the record sources", error);
    }
  }, []);

  const readNewest = useCallback(async () => {
    const signal = begin("newest");
    try {
      const page = await window.zipkit.readRecordsPage({ ...filtersRef.current, after: null });
      if (signal.aborted) return;
      loaded.current = mergeNewestPage(loaded.current.records, loaded.current.more, page);
      failures.current.delete("list");
      setStatus("ready");
    } catch (error) {
      if (signal.aborted) return;
      failed("list", "read the newest records", error);
      if (loaded.current.records.length === 0) setStatus("failed");
    } finally {
      end(signal);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!loaded.current.more || reader.current || failures.current.size > 0) return;
    const signal = begin("more");
    changed();
    const after = cursorAfter(loaded.current.records);
    try {
      const page = await window.zipkit.readRecordsPage({ ...filtersRef.current, after });
      if (signal.aborted) return;
      loaded.current = { records: [...loaded.current.records, ...page.records], more: page.more };
      failures.current.delete("list");
    } catch (error) {
      if (!signal.aborted) failed("list", "read more records", error);
    } finally {
      end(signal);
    }
  }, []);

  // Sources and the newest records recover independently; reading more
  // resumes once the list is current again.
  const retry = useCallback(async () => {
    await Promise.all([readSources(), readNewest()]);
  }, [readSources, readNewest]);

  // New filters start the list over.
  useEffect(() => {
    filtersRef.current = filters;
    loaded.current = { records: [], more: false };
    failures.current.delete("list");
    setStatus("loading");
    void readNewest();
    return () => reader.current?.aborter.abort();
  }, [filters, readNewest]);

  useEffect(() => {
    void readSources();
    return () => sourcesReader.current?.abort();
  }, [readSources]);

  return { records: loaded.current.records, revision, status, sources, stale: failures.current.size > 0,
    loadingMore: reader.current?.kind === "more", loadMore, readNewest, retry };
}
