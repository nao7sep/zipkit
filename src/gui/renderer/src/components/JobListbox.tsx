/**
 * The queue list as a conforming listbox (composite-control conventions).
 *
 * - One tab stop via roving tabindex: the selected option carries tabindex 0
 *   (the first option when nothing is selected yet), every other option -1; an
 *   empty list keeps the container itself focusable.
 * - Arrow Up/Down, Home/End, PageUp/PageDown move the active option; type-ahead
 *   jumps by label. All key handling is IME-guarded — mid-composition those keys
 *   belong to the IME.
 * - Single-select with activation following focus: moving the active option
 *   selects it (the detail pane is a cheap local commit).
 * - Deterministic recovery on removal (next -> previous -> empty), with focus
 *   moved to the neighbor BEFORE the row unmounts so it never drops to the body.
 * - Row actions (Cancel, Remove) are pointer-only affordances (tabindex -1), not
 *   nested tab stops; Delete removes and Escape cancels the active row from the
 *   keyboard. Selection is the single source of truth, owned by the parent; DOM
 *   focus, scroll, and aria-selected are projections of it.
 */

import { useEffect, useRef } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { Job } from "../../../shared/api";
import { intentLabel, label, stateTint } from "../view";
import { navIndex, recoverIndex, typeaheadIndex } from "../listbox-nav";
import { isComposing } from "../composition";
import { StateBadge } from "./StateBadge";

const TYPEAHEAD_IDLE_MS = 600;

export function JobListbox({
  jobs,
  selectedId,
  onSelect,
  onRemove,
  onCancel,
}: {
  jobs: Job[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const taBuffer = useRef("");
  const taTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const activeIndex = jobs.findIndex((j) => j.id === selectedId);

  // Keep the active option in view and focused when selection changes — but only
  // when focus already lives in the listbox, so selection never steals focus.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !list.contains(document.activeElement)) return;
    const el = optionEl(list, selectedId);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  function activate(index: number) {
    const job = jobs[index];
    if (!job) return;
    onSelect(job.id);
    const el = optionEl(listRef.current, job.id);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  }

  function remove(job: Job) {
    // Move focus before the row unmounts (roving tabindex: removing the focused
    // element drops focus to the page body). When the removed row is the active
    // one, recover deterministically to a neighbor; otherwise just keep focus in
    // the list when the removed row's own button held it.
    const list = listRef.current;
    const hadFocus = !!list && !!optionEl(list, job.id)?.contains(document.activeElement);
    if (job.id === selectedId) {
      const rec = recoverIndex(
        jobs.findIndex((j) => j.id === job.id),
        jobs.length,
      );
      const neighbor = rec === null ? null : jobs.filter((j) => j.id !== job.id)[rec];
      onSelect(neighbor?.id ?? null);
      if (hadFocus) (neighbor ? optionEl(list, neighbor.id) : list)?.focus();
    } else if (hadFocus) {
      (optionEl(list, selectedId) ?? list)?.focus();
    }
    onRemove(job.id);
  }

  // Page size from the actual layout — how many rows fit the scroll viewport —
  // rather than a fixed guess.
  function pageSize(): number {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[role="option"]');
    if (!list || !row || row.offsetHeight === 0) return 10;
    return Math.max(1, Math.floor(list.clientHeight / row.offsetHeight));
  }

  function onKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    if (isComposing(e)) return; // mid-composition these keys belong to the IME
    const active = jobs[activeIndex];

    if (e.key === "Delete" || e.key === "Backspace") {
      if (active && active.state !== "running") {
        e.preventDefault();
        remove(active);
      }
      return;
    }
    if (e.key === "Escape") {
      if (active && (active.state === "planning" || active.state === "running")) {
        e.preventDefault();
        onCancel(active.id);
      }
      return;
    }

    const next = navIndex(activeIndex, jobs.length, e.key, pageSize());
    if (next !== null) {
      e.preventDefault();
      taBuffer.current = "";
      activate(next);
      return;
    }

    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      taBuffer.current += e.key;
      clearTimeout(taTimer.current);
      taTimer.current = setTimeout(() => {
        taBuffer.current = "";
      }, TYPEAHEAD_IDLE_MS);
      const hit = typeaheadIndex(jobs.map(label), activeIndex, taBuffer.current);
      if (hit !== null) {
        e.preventDefault();
        activate(hit);
      }
    }
  }

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label="Job queue"
      tabIndex={jobs.length === 0 ? 0 : -1}
      onKeyDown={onKeyDown}
      style={S.listCol}
    >
      {jobs.length === 0 ? (
        <li role="presentation" style={S.empty}>
          No jobs yet. Click “Add” to choose directories or files.
        </li>
      ) : (
        jobs.map((job, i) => {
          const selected = job.id === selectedId;
          const tabbable = activeIndex < 0 ? i === 0 : selected;
          return (
            <li
              key={job.id}
              data-job-id={job.id}
              role="option"
              aria-selected={selected}
              tabIndex={tabbable ? 0 : -1}
              onClick={() => activate(i)}
              style={{
                ...S.jobRow,
                background: stateTint(job.state),
                ...(selected ? S.jobRowSel : null),
              }}
            >
              {/* Filename gets the full top line; status sits under it so a long
                  name is never squeezed by a leading badge. */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={S.name}>{label(job)}</div>
                <div style={S.meta}>
                  <StateBadge state={job.state} />
                  {metaText(job) && <span style={S.dim}>{metaText(job)}</span>}
                </div>
              </div>
              {(job.state === "planning" || job.state === "running") && (
                <button
                  className="icon"
                  tabIndex={-1}
                  title="Cancel (Esc)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCancel(job.id);
                  }}
                  style={S.rowAction}
                >
                  Cancel
                </button>
              )}
              {job.state !== "running" && (
                <button
                  className="icon"
                  tabIndex={-1}
                  title="Remove (Del)"
                  aria-label="Remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(job);
                  }}
                  style={S.rowAction}
                >
                  <CloseIcon />
                </button>
              )}
            </li>
          );
        })
      )}
    </ul>
  );
}

/** The dim sub-line beside the state badge: the noteworthy intent tag (nothing
 *  for the default save) and the job message, whichever are present. */
function metaText(job: Job): string {
  return [intentLabel(job.intent), job.message].filter(Boolean).join(" · ");
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function optionEl(list: HTMLUListElement | null, id: string | null): HTMLElement | null {
  if (!list || id === null) return null;
  return list.querySelector<HTMLElement>(`[data-job-id="${id}"]`);
}

const S: Record<string, CSSProperties> = {
  // Fills the host pane and is its own scroll container, so PageUp/Down can size
  // off the viewport. The pane/left column owns the width.
  listCol: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    margin: 0,
    padding: 0,
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    overflowY: "auto",
  },
  jobRow: {
    display: "flex",
    gap: "0.5rem",
    alignItems: "flex-start",
    padding: "0.5rem 0.6rem",
    border: "1px solid var(--border)",
    borderRadius: 6,
    cursor: "pointer",
  },
  // Selection reads as an accent ring on top of the state tint, so both the
  // status (background) and the selection are visible at once.
  jobRowSel: { borderColor: "var(--accent)", boxShadow: "0 0 0 1px var(--accent)" },
  name: {
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  meta: {
    display: "flex",
    gap: "0.4rem",
    alignItems: "baseline",
    flexWrap: "wrap",
    marginTop: "0.15rem",
  },
  dim: { color: "var(--text-2)", fontSize: "0.8rem" },
  rowAction: { flexShrink: 0, marginTop: "-0.1rem" },
  empty: { padding: "0.75rem", color: "var(--text-2)", fontSize: "0.85rem", cursor: "default" },
};
