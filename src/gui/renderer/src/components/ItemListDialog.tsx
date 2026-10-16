/**
 * Every row of one of a job's lists, for a user who wants to see them all
 * before trusting ZipKit with the originals: by path, or grouped by name so
 * every `.DS_Store` sits under one counted heading and a whole group of
 * expected junk is passed over at a glance, while an odd one out stands alone.
 * The list is virtualized (volume-handling conventions, Item count): only the
 * rows in or near the view are drawn, however many there are. The chosen order
 * is remembered in this window only.
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ModalShell } from "./ModalShell";
import { ReportRowView } from "./ReportRowView";
import { useI18n } from "../i18n/I18nContext";
import { rowsByName, rowsByPath, splitName, type ReportRow } from "../view";

export type ListOrder = "path" | "name";
const ORDER_KEY = "zipkit.listOrder";

function savedOrder(): ListOrder {
  try { return localStorage.getItem(ORDER_KEY) === "name" ? "name" : "path"; }
  catch { return "path"; }
}

type Item =
  | { kind: "heading"; key: string; text: string }
  | { kind: "row"; key: string; row: ReportRow; inGroup: boolean };

export function ItemListDialog({
  title,
  rows,
  onClose,
}: {
  title: string;
  rows: readonly ReportRow[];
  onClose: () => void;
}) {
  const t = useI18n();
  const [order, setOrder] = useState<ListOrder>(savedOrder);
  const choose = (next: ListOrder): void => {
    setOrder(next);
    try { localStorage.setItem(ORDER_KEY, next); } catch { /* remembered for this view only */ }
  };
  const items = useMemo((): Item[] => {
    if (order === "path") return rowsByPath(rows).map((row, i) => ({ kind: "row", key: `p:${i}`, row, inGroup: false }));
    const { repeated, single } = rowsByName(rows);
    return [
      ...repeated.flatMap((group, g): Item[] => [
        { kind: "heading", key: `h:${g}`, text: t.t("details.counted", { name: group.name, count: t.number(group.rows.length) }) },
        ...group.rows.map((row, i): Item => ({ kind: "row", key: `r:${g}:${i}`, row, inGroup: true })),
      ]),
      ...single.map((row, i): Item => ({ kind: "row", key: `s:${i}`, row, inGroup: false })),
    ];
  }, [order, rows, t]);

  return (
    <ModalShell
      title={title}
      onClose={onClose}
      width="min(48rem, 90vw)"
      footer={
        <>
          <div role="radiogroup" aria-label={t.t("details.order")} style={S.orders}>
            {(["path", "name"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={order === value}
                className={order === value ? "accent" : undefined}
                onClick={() => choose(value)}
              >
                {t.t(value === "path" ? "details.byPath" : "details.byName")}
              </button>
            ))}
          </div>
          <button data-modal-autofocus onClick={onClose}>{t.t("common.close")}</button>
        </>
      }
    >
      <VirtualRows items={items} />
    </ModalShell>
  );
}

function VirtualRows({ items }: { items: readonly Item[] }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setScrollElement(scrollParent(listRef.current)); }, []);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElement,
    estimateSize: (index) => (items[index]!.kind === "heading" ? 30 : 40),
    getItemKey: (index) => items[index]!.key,
    overscan: 8,
    initialRect: { width: 0, height: window.innerHeight },
  });
  return (
    <div ref={listRef} style={{ position: "relative", height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((virtual) => {
        const item = items[virtual.index]!;
        return (
          <div
            key={virtual.key}
            data-index={virtual.index}
            ref={virtualizer.measureElement}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtual.start}px)`, paddingBottom: "0.45rem" }}
          >
            {item.kind === "heading"
              ? <h3 style={S.heading}>{item.text}</h3>
              // In a group the heading names the item, so each row shows only
              // where it is.
              : item.inGroup
                ? <span style={S.groupedFolder}>{splitName(item.row.path).folder || item.row.path}</span>
                : <ReportRowView row={item.row} variant="full" />}
          </div>
        );
      })}
    </div>
  );
}

/** The nearest ancestor that scrolls: the dialog's body. */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

const S: Record<string, CSSProperties> = {
  // The order choice sits at the footer's start, away from Close.
  orders: { display: "flex", gap: "0.35rem", marginInlineEnd: "auto" },
  heading: { margin: "0.4rem 0 0.2rem", fontSize: "0.85rem", fontWeight: 600 },
  groupedFolder: { display: "block", fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--text-2)", overflowWrap: "anywhere", paddingInlineStart: "0.75rem" },
};
