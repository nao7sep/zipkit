/**
 * The Records window: `records.sqlite3` read back. Left, the records newest
 * first under their filters; right, the selected record whole, every field as
 * stored; a splitter between them. The list is one listbox
 * (composite-control-conventions, Listbox) whose selection follows focus, paged
 * by a cursor as it is scrolled or navigated to its end, and kept current as
 * new records are stored.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactElement, ReactNode } from "react";
import {
  BODY_PADDING,
  RECORDS_DETAIL_MIN_WIDTH,
  RECORDS_FILTERS_GAP,
  RECORDS_FILTERS_PADDING,
  RECORDS_LIST_WIDTH,
  SPLITTER_WIDTH,
  clampRecordsListWidth,
  recordsListDisplayWidth,
} from "../../../shared/layout";
import {
  RECORD_KINDS,
  RECORD_LEVEL_FILTERS,
  type RecordDetail,
  type RecordKind,
  type RecordLevelFilter,
  type RecordSources,
  type RecordsQuery,
  type RecordSummary,
} from "../../../shared/records";
import { Splitter } from "../components/Splitter";
import { isComposing } from "../composition";
import { reportableError } from "../externalDropBoundary";
import { useI18n } from "../i18n/I18nContext";
import { navIndex } from "../listbox-nav";
import {
  KIND_LABELS,
  LEVEL_FILTER_LABELS,
  LEVEL_LABELS,
  LEVEL_PILLS,
  cursorAfter,
  mergeNewestPage,
  recordDetails,
  recordKey,
} from "./record-format";

function report(context: string, error: unknown): void {
  window.zipkit.reportError(context, reportableError(error));
}

/** The window's content once the list pane's saved width is known, so its
 *  first frame already has it. The UI font follows the main window's setting. */
export function RecordsApp(): ReactElement | null {
  const [listWidth, setListWidth] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.zipkit.getRecordsListWidth().then(
      (width) => {
        if (!cancelled) setListWidth(width);
      },
      (error: unknown) => {
        report("read the records list width", error);
        if (!cancelled) setListWidth(RECORDS_LIST_WIDTH.default);
      },
    );
    window.zipkit.getSettings().then(
      (settings) => {
        const family = settings.uiFontFamily.trim();
        if (!cancelled && family) document.documentElement.style.setProperty("--font-ui", family);
      },
      (error: unknown) => report("read the UI font for the Records window", error),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (listWidth === null) return null;
  return <RecordsWindow initialListWidth={listWidth} />;
}

type Filters = Omit<RecordsQuery, "after">;

const NO_FILTERS: Filters = { session: null, kind: null, level: null, search: "" };
const SEARCH_DELAY_MS = 300;
// New records are read at most this often while they keep arriving.
const LIVE_INTERVAL_MS = 1000;

type ListState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; records: RecordSummary[]; more: boolean; loadingMore: boolean; moreFailed: boolean };

type DetailState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; record: RecordDetail };

type Selection = { kind: RecordKind; id: number };

// Within about one screen of the end of what is loaded.
function nearEnd(scroll: HTMLElement): boolean {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= scroll.clientHeight;
}

function atTop(scroll: HTMLElement): boolean {
  return scroll.scrollTop < 1;
}

export function RecordsWindow({ initialListWidth }: { initialListWidth: number }): ReactElement {
  const t = useI18n();
  const [sources, setSources] = useState<RecordSources | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [searchText, setSearchText] = useState("");
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [selected, setSelected] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: "none" });
  // The list width the user dragged to (the persisted intent), the width while
  // a drag is under way, and the shell's live width, which narrows only what is
  // shown (window-conventions, Content-based minimum size).
  const [listWidth, setListWidth] = useState(initialListWidth);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragWidthRef = useRef<number | null>(null);
  const dragBase = useRef(initialListWidth);
  const [shellWidth, setShellWidth] = useState(0);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const listGeneration = useRef(0);
  // The busy claim for the next page (PLAYBOOK, Own the work in flight).
  const fetchingMore = useRef(false);
  // The filters the current list was read for, for the live reads below.
  const filtersRef = useRef(filters);
  // New records arrived while the list was scrolled away from the top.
  const newestPending = useRef(false);
  // A failed read is itself logged as a record, whose signal would start the
  // next read; live reads stop after a failure and resume after a read succeeds.
  const liveSuspended = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const shownListWidth = recordsListDisplayWidth(dragWidth ?? listWidth, shellWidth);

  const preciseTime = useMemo(
    () =>
      new Intl.DateTimeFormat(t.locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
      }),
    [t.locale],
  );

  useEffect(() => {
    document.title = t.t("records.title");
  }, [t]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const observer = new ResizeObserver(() => setShellWidth(shell.clientWidth));
    observer.observe(shell);
    setShellWidth(shell.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((current) => (current.search === searchText ? current : { ...current, search: searchText }));
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  // The launches only grow by a new launch, never while this one runs, so they
  // are read once.
  useEffect(() => {
    let cancelled = false;
    window.zipkit.readRecordSources().then(
      (next) => {
        if (!cancelled) setSources(next);
      },
      (error: unknown) => {
        liveSuspended.current = true;
        report("read the record sources", error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // A page applies only while the filters it was read for are still the
  // newest ones asked for.
  useEffect(() => {
    filtersRef.current = filters;
    const generation = ++listGeneration.current;
    fetchingMore.current = false;
    newestPending.current = false;
    setList({ status: "loading" });
    window.zipkit.readRecordsPage({ ...filters, after: null }).then(
      (page) => {
        if (generation !== listGeneration.current) return;
        liveSuspended.current = false;
        setList({ status: "ready", records: page.records, more: page.more, loadingMore: false, moreFailed: false });
      },
      (error: unknown) => {
        if (generation !== listGeneration.current) return;
        liveSuspended.current = true;
        report("read the records", error);
        setList({ status: "failed" });
      },
    );
  }, [filters]);

  // The newest page read again for new records. It joins the rows already
  // shown rather than replacing them, so the list never falls back to the
  // loading note and the pages already read stay. It reads only refs, so one
  // copy serves the live subscription below.
  const readNewest = useCallback((): void => {
    const generation = listGeneration.current;
    window.zipkit.readRecordsPage({ ...filtersRef.current, after: null }).then(
      (page) => {
        if (generation !== listGeneration.current) return;
        liveSuspended.current = false;
        setList((current) =>
          current.status === "ready"
            ? { ...current, ...mergeNewestPage(current.records, current.more, page) }
            : { status: "ready", records: page.records, more: page.more, loadingMore: false, moreFailed: false },
        );
      },
      (error: unknown) => {
        if (generation !== listGeneration.current) return;
        liveSuspended.current = true;
        report("read the newest records", error);
      },
    );
  }, []);

  // A stored record reaches the list at once while it is scrolled to the top;
  // otherwise it waits until the list is back there, so the list never moves
  // under the reader.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = window.zipkit.onRecordsChanged(() => {
      if (timer !== null || liveSuspended.current) return;
      timer = setTimeout(() => {
        timer = null;
        const scroll = scrollRef.current;
        if (scroll === null || atTop(scroll)) readNewest();
        else newestPending.current = true;
      }, LIVE_INTERVAL_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [readNewest]);

  const selectedKey = selected === null ? null : recordKey(selected);

  useEffect(() => {
    if (selected === null) {
      setDetail({ status: "none" });
      return;
    }
    let cancelled = false;
    setDetail({ status: "loading" });
    window.zipkit.readRecordDetail(selected.kind, selected.id).then(
      (record) => {
        if (!cancelled) setDetail(record === null ? { status: "failed" } : { status: "ready", record });
      },
      (error: unknown) => {
        if (cancelled) return;
        report("read a record", error);
        setDetail({ status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
    // The selection is compared by its key, not by the object holding it.
  }, [selectedKey]);

  // Loading more: composite-control-conventions, Integration Points. A failed
  // page is read again when the end is reached again.
  const loadMore = (): void => {
    if (list.status !== "ready" || !list.more || fetchingMore.current) return;
    fetchingMore.current = true;
    const generation = listGeneration.current;
    setList((current) => (current.status === "ready" ? { ...current, loadingMore: true, moreFailed: false } : current));
    window.zipkit.readRecordsPage({ ...filters, after: cursorAfter(list.records) }).then(
      (page) => {
        if (generation !== listGeneration.current) return;
        fetchingMore.current = false;
        liveSuspended.current = false;
        setList((current) =>
          current.status === "ready"
            ? { ...current, records: [...current.records, ...page.records], more: page.more, loadingMore: false }
            : current,
        );
      },
      (error: unknown) => {
        if (generation !== listGeneration.current) return;
        fetchingMore.current = false;
        liveSuspended.current = true;
        report("read more records", error);
        setList((current) => (current.status === "ready" ? { ...current, loadingMore: false, moreFailed: true } : current));
      },
    );
  };

  // A page that leaves the list short of the end reads the next one; a failed
  // page waits for the reader instead.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (list.status !== "ready" || list.loadingMore || list.moreFailed || scroll === null) return;
    if (nearEnd(scroll)) loadMore();
    // Only a new list state can change what is loaded.
  }, [list]);

  const onListScroll = (): void => {
    const scroll = scrollRef.current;
    if (scroll === null) return;
    if (newestPending.current && atTop(scroll)) {
      newestPending.current = false;
      readNewest();
    }
    if (nearEnd(scroll)) loadMore();
  };

  const records = list.status === "ready" ? list.records : [];
  const keys = records.map(recordKey);
  const tabStopKey = selectedKey !== null && keys.includes(selectedKey) ? selectedKey : (keys[0] ?? null);

  const select = (record: RecordSummary): void => {
    if (recordKey(record) !== selectedKey) setSelected({ kind: record.kind, id: record.id });
  };

  // How many rows fit the list's viewport, for PageUp and PageDown.
  const pageSize = (): number => {
    const scroll = scrollRef.current;
    const row = listRef.current?.querySelector<HTMLElement>("[data-record-key]");
    if (!scroll || !row || row.offsetHeight === 0) return 10;
    return Math.max(1, Math.floor(scroll.clientHeight / row.offsetHeight));
  };

  // The selection follows focus; the arrow keys stop at the ends.
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isComposing(event)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.recordKey : undefined;
    const current = keys.indexOf(focused ?? selectedKey ?? "");
    const target = navIndex(current, keys.length, event.key, pageSize());
    if (target === null) return;
    event.preventDefault();
    const option = listRef.current?.querySelector<HTMLElement>(`[data-record-key="${CSS.escape(keys[target]!)}"]`);
    option?.focus();
    option?.scrollIntoView({ block: "nearest" });
    if (target === keys.length - 1 && (event.key === "ArrowDown" || event.key === "PageDown" || event.key === "End")) {
      loadMore();
    }
  };

  // Only the end of a drag saves (window-conventions, Persist the user's drag intent).
  const commitListWidth = (width: number): void => {
    const next = clampRecordsListWidth(width);
    setListWidth(next);
    setDragWidth(null);
    dragWidthRef.current = null;
    window.zipkit.saveRecordsListWidth(next).then(setListWidth, (error: unknown) =>
      report("save the records list width", error),
    );
  };

  const launchLabel = (session: string): string => {
    const time = t.logTime(new Date(session));
    return session === sources?.currentSession ? t.t("records.thisLaunch", { time }) : time;
  };

  const sessions = sources === null
    ? []
    : sources.sessions.includes(sources.currentSession)
      ? sources.sessions
      : [sources.currentSession, ...sources.sessions];

  const shellStyle: CSSProperties = {
    padding: BODY_PADDING,
    gridTemplateColumns: `${shownListWidth}px ${SPLITTER_WIDTH}px minmax(${RECORDS_DETAIL_MIN_WIDTH}px, 1fr)`,
  };
  const filtersStyle: CSSProperties = { padding: RECORDS_FILTERS_PADDING, gap: RECORDS_FILTERS_GAP };
  const filterRowStyle: CSSProperties = { gap: RECORDS_FILTERS_GAP };

  return (
    <div ref={shellRef} className="records-shell" style={shellStyle}>
      <section className="records-pane" aria-label={t.t("records.title")}>
        <div className="records-filters" style={filtersStyle}>
          <input
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder={t.t("records.search")}
            aria-label={t.t("records.search")}
          />
          <FilterSelect
            label={t.t("records.launch")}
            value={filters.session}
            allLabel={t.t("records.allLaunches")}
            options={sessions.map((session) => ({ value: session, label: launchLabel(session) }))}
            onChange={(session) => setFilters({ ...filters, session })}
          />
          <div className="records-filters__row" style={filterRowStyle}>
            <FilterSelect
              label={t.t("records.kind")}
              value={filters.kind}
              allLabel={t.t("records.allKinds")}
              options={RECORD_KINDS.map((kind) => ({ value: kind, label: t.t(KIND_LABELS[kind]) }))}
              onChange={(kind) => setFilters({ ...filters, kind: kind as RecordKind | null })}
            />
            <FilterSelect
              label={t.t("records.level")}
              value={filters.level}
              allLabel={t.t("records.allLevels")}
              options={RECORD_LEVEL_FILTERS.map((level) => ({ value: level, label: t.t(LEVEL_FILTER_LABELS[level]) }))}
              onChange={(level) => setFilters({ ...filters, level: level as RecordLevelFilter | null })}
            />
          </div>
        </div>
        <div ref={scrollRef} className="records-list-scroll" onScroll={onListScroll}>
          <div
            ref={listRef}
            role="listbox"
            aria-label={t.t("records.title")}
            aria-busy={list.status === "loading"}
            tabIndex={records.length === 0 ? 0 : -1}
            className="records-list"
            onKeyDown={onListKeyDown}
          >
            {list.status === "loading" ? (
              <p role="presentation" className="records-note">{t.t("records.loading")}</p>
            ) : list.status === "ready" && records.length === 0 ? (
              <p role="presentation" className="records-note">{t.t("records.empty")}</p>
            ) : (
              records.map((record) => {
                const key = recordKey(record);
                return (
                  <div
                    key={key}
                    role="option"
                    aria-selected={key === selectedKey}
                    tabIndex={key === tabStopKey ? 0 : -1}
                    data-record-key={key}
                    className={`records-row${key === selectedKey ? " records-row--selected" : ""}`}
                    onClick={() => select(record)}
                    onFocus={() => select(record)}
                  >
                    <div className="records-row__meta">
                      <span>{t.logTime(new Date(record.time))}</span>
                      <span className={LEVEL_PILLS[record.level]}>{t.t(LEVEL_LABELS[record.level])}</span>
                      {record.kind === "job-event" ? <span className="records-pill">{t.t(KIND_LABELS[record.kind])}</span> : null}
                    </div>
                    <div className="records-row__title">{record.title}</div>
                    {record.text ? <div className="records-row__text">{record.text}</div> : null}
                  </div>
                );
              })
            )}
          </div>
          {list.status === "failed" ? (
            <p role="alert" className="records-note records-note--error">{t.t("records.loadFailed")}</p>
          ) : null}
          {list.status === "ready" && list.loadingMore ? (
            <p className="records-note">{t.t("records.loading")}</p>
          ) : null}
          {list.status === "ready" && list.moreFailed ? (
            <p role="alert" className="records-note records-note--error">{t.t("records.loadFailed")}</p>
          ) : null}
        </div>
      </section>
      <Splitter
        label={t.t("records.resizeList")}
        value={shownListWidth}
        min={RECORDS_LIST_WIDTH.min}
        max={RECORDS_LIST_WIDTH.max}
        onDragStart={() => {
          dragBase.current = shownListWidth;
        }}
        onDragDelta={(dx) => {
          const next = clampRecordsListWidth(dragBase.current + dx);
          dragWidthRef.current = next;
          setDragWidth(next);
        }}
        onDragEnd={() => {
          if (dragWidthRef.current !== null) commitListWidth(dragWidthRef.current);
        }}
        onDragCancel={() => {
          dragWidthRef.current = null;
          setDragWidth(null);
        }}
        onKeyboardDelta={(dx) => {
          const next = clampRecordsListWidth((dragWidthRef.current ?? shownListWidth) + dx);
          dragWidthRef.current = next;
          setDragWidth(next);
        }}
        onKeyboardCommit={() => {
          if (dragWidthRef.current !== null) commitListWidth(dragWidthRef.current);
        }}
      />
      <section className="records-pane" aria-busy={detail.status === "loading"}>
        {detail.status === "ready" ? (
          <RecordDetailView record={detail.record} preciseTime={preciseTime} launchLabel={launchLabel} />
        ) : (
          <p className={`records-note${detail.status === "failed" ? " records-note--error" : ""}`}>
            {detail.status === "failed"
              ? t.t("records.detailFailed")
              : detail.status === "none"
                ? t.t("records.noSelection")
                : null}
          </p>
        )}
      </section>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  allLabel,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  allLabel: string;
  options: { value: string; label: string }[];
  onChange: (value: string | null) => void;
}): ReactElement {
  // A chosen value the sources no longer list stays selectable until changed.
  const shown = value === null || options.some((option) => option.value === value)
    ? options
    : [{ value, label: value }, ...options];
  return (
    <select
      aria-label={label}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
    >
      <option value="">{allLabel}</option>
      {shown.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

function RecordDetailView({
  record,
  preciseTime,
  launchLabel,
}: {
  record: RecordDetail;
  preciseTime: Intl.DateTimeFormat;
  launchLabel: (session: string) => string;
}): ReactElement {
  const t = useI18n();

  const fields: { label: string; value: ReactNode }[] = [];
  const add = (label: string, value: ReactNode | null): void => {
    if (value !== null) fields.push({ label, value });
  };
  add(t.t("records.time"), preciseTime.format(new Date(record.time)));
  if (record.kind === "job-event") {
    add(t.t("records.event"), <code>{record.event}</code>);
    add(t.t("records.sequence"), t.number(record.seq));
  }
  add(t.t("records.job"), record.jobId === null ? null : <code>{record.jobId}</code>);
  add(t.t("records.launch"), launchLabel(record.session));

  const details = recordDetails(record);

  return (
    <>
      <div className="records-detail__header">
        <h2 className="records-detail__title">{record.kind === "log" ? record.message : record.event}</h2>
        <div className="records-detail__pills">
          <span className={LEVEL_PILLS[record.level]}>{t.t(LEVEL_LABELS[record.level])}</span>
          <span className="records-pill">{t.t(KIND_LABELS[record.kind])}</span>
        </div>
      </div>
      <div className="records-detail__body" role="region" tabIndex={0} aria-label={t.t("records.details")}>
        <dl className="records-meta">
          {fields.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
        {details !== null && (
          <section className="records-block">
            <h3 className="records-block__label">{t.t("records.details")}</h3>
            <pre className="records-block__text">{details}</pre>
          </section>
        )}
      </div>
    </>
  );
}
