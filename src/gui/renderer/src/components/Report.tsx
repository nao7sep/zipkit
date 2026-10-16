/**
 * The job's lists: one row per file with every change to it, grouped by kind
 * (issues that block, warnings, renames, exclusions), each group colored by
 * level, then the paths a verification found missing or unexpected. It sits in
 * the right pane until that pane shows only what the user needs when it is
 * needed; what happened to the job is said once, in the Archive pane's history.
 * The derivations are pure (`planReport` in view); this just renders. The
 * parent clears stale state (verify, the plan) at the right times, so the lists
 * never show a result that no longer holds.
 */

import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { CSSProperties } from "react";
import type { PlanReport, VerifyResult } from "../../../shared/api";
import { useI18n } from "../i18n/I18nContext";
import {
  planReport,
  reportGroupLevel,
  reportGroupTitle,
  renameDisplay,
  severityColor,
  type ReportGroup,
  type ReportLine,
  type ReportRow,
} from "../view";

/** Memoized: the window re-renders on every Progress batch, and the lists
 *  depend only on the plan and the verification. */
export const Report = memo(function Report({
  plan,
  verify,
}: {
  plan: PlanReport | null;
  verify: VerifyResult | null;
}) {
  const t = useI18n();
  const groups = useMemo(() => (plan ? planReport(plan, t) : []), [plan, t]);
  const verifyData = verify?.ok ? verify.data : null;
  // Paths the verification found missing or unexpected are listed one per row,
  // like the plan's groups, rather than joined into one sentence that grows
  // with the archive (interface-styling-conventions, Labels).
  const verifyGroups = useMemo((): PathGroupData[] => verifyData
    ? [
        { title: t.t("report.missing", { count: verifyData.missing.length }), level: "error" as const, paths: verifyData.missing },
        { title: t.t("report.extra", { count: verifyData.extra.length }), level: "warning" as const, paths: verifyData.extra },
      ].filter((group) => group.paths.length > 0)
    : [], [verifyData, t]);
  return <ReportRows groups={groups} verifyGroups={verifyGroups} />;
});

interface PathGroupData {
  title: string;
  level: ReportLine["level"];
  paths: string[];
}

/** One line of the report's lists: a group's heading, or one of its rows. */
type ReportItem =
  | { kind: "title"; key: string; text: string }
  | { kind: "row"; key: string; color: string; row: ReportRow; last: boolean }
  | { kind: "path"; key: string; color: string; path: string; last: boolean };

function reportItems(groups: readonly ReportGroup[], verifyGroups: readonly PathGroupData[], t: ReturnType<typeof useI18n>): ReportItem[] {
  const items: ReportItem[] = [];
  for (const group of groups) {
    const color = severityColor(reportGroupLevel(group.kind));
    items.push({ kind: "title", key: `title:${group.kind}`, text: t.t(reportGroupTitle(group.kind), { count: group.rows.length }) });
    group.rows.forEach((row, i) => items.push({ kind: "row", key: `${group.kind}:${i}`, color, row, last: i === group.rows.length - 1 }));
  }
  for (const group of verifyGroups) {
    const color = severityColor(group.level);
    items.push({ kind: "title", key: `title:${group.title}`, text: group.title });
    group.paths.forEach((path, i) => items.push({ kind: "path", key: `${group.title}:${i}`, color, path, last: i === group.paths.length - 1 }));
  }
  return items;
}

/** The nearest ancestor that scrolls: the Archive pane's body. */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/**
 * The report's groups as one virtualized list (volume-handling conventions,
 * Item count): only the lines in or near the pane's view are drawn, each
 * measured as it appears, so a folder that flags every file costs no more to
 * show than its visible rows. The list scrolls with the pane, below whatever
 * the report shows above it.
 */
function ReportRows({ groups, verifyGroups }: { groups: readonly ReportGroup[]; verifyGroups: readonly PathGroupData[] }) {
  const t = useI18n();
  const items = useMemo(() => reportItems(groups, verifyGroups, t), [groups, verifyGroups, t]);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => { setScrollElement(scrollParent(listRef.current)); }, []);
  // The text above the list can change height, so its start is measured on each render.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !scrollElement) return;
    const next = list.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop;
    if (next !== offset) setOffset(next);
  });
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElement,
    estimateSize: (index) => (items[index]!.kind === "title" ? 28 : 40),
    getItemKey: (index) => items[index]!.key,
    scrollMargin: offset,
    overscan: 8,
    initialRect: { width: 0, height: window.innerHeight },
  });
  if (items.length === 0) return null;
  return (
    <div ref={listRef} style={{ position: "relative", height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((virtual) => {
        const item = items[virtual.index]!;
        return (
          <div
            key={virtual.key}
            data-index={virtual.index}
            ref={virtualizer.measureElement}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtual.start - offset}px)` }}
          >
            {item.kind === "title" ? (
              <h3 style={S.groupTitle}>{item.text}</h3>
            ) : (
              <div style={{ ...S.fileRow, borderColor: item.color, marginBottom: item.last ? "0.6rem" : "0.3rem" }}>
                {item.kind === "row" ? (
                  <>
                    <RowPath row={item.row} />
                    {item.row.changes.map((change, j) => (
                      <span key={j} style={S.change}>{change}</span>
                    ))}
                  </>
                ) : (
                  <span style={S.path}>{item.path}</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A row's path: the archive path, with a rename's removed and added
 *  characters marked. The marks are visual only; a screen reader hears the
 *  path and the name it had on disk. */
function RowPath({ row }: { row: ReportRow }) {
  const t = useI18n();
  const shown = row.from === undefined ? null : renameDisplay(row.from, row.path);
  if (row.from === undefined || shown === null || shown.kind === "same") {
    return <span style={S.path}>{row.path}</span>;
  }
  return (
    <span style={S.path}>
      <span style={S.srOnly}>{row.path} </span>
      <span aria-hidden="true">
        {shown.parts.map((part, i) =>
          part.change === "removed" ? (
            <del key={i} style={S.removed}>{part.text}</del>
          ) : part.change === "added" ? (
            <ins key={i} style={S.added}>{part.text}</ins>
          ) : (
            <span key={i}>{part.text}</span>
          ),
        )}
      </span>
      <span style={S.srOnly}>{t.t("report.renamedFrom", { from: row.from })}</span>
    </span>
  );
}

const S: Record<string, CSSProperties> = {
  groupTitle: { margin: "0 0 0.35rem", fontSize: "0.85rem", fontWeight: 600 },
  fileRow: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    borderLeft: "2px solid",
    paddingLeft: "0.55rem",
  },
  change: { fontSize: "0.85rem", wordBreak: "break-word" },
  path: { fontFamily: "var(--font-mono)", fontSize: "0.8rem", wordBreak: "break-all" },
  // A removed character is struck through in the error colour; an added one
  // sits on a tint of the success colour, in the text colour so it stays legible.
  removed: { color: "var(--status-error)", textDecoration: "line-through" },
  added: {
    textDecoration: "none",
    background: "color-mix(in srgb, var(--status-ok) 24%, transparent)",
    borderRadius: 2,
  },
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: 0,
  },
};
