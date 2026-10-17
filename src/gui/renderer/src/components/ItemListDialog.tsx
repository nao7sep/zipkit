/**
 * Details of one Status card: what this kind of thing is and what ZipKit does
 * about it, then every item, for a user who wants to see each one before
 * trusting ZipKit with the originals. Items are listed by path; a card of
 * excluded items can also group them by name, so every `.DS_Store` sits
 * under one counted heading and a whole group of expected junk is passed over
 * at a glance while an odd one out stands alone. The choice sits at the
 * footer's start, offered only when some name occurs more than once. The list is virtualized
 * (volume-handling conventions, Item count): only the rows in or near the view
 * are drawn, however many there are. Grouping is remembered in this window.
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ModalShell } from "./ModalShell";
import { ReportRowView } from "./ReportRowView";
import { useI18n } from "../i18n/I18nContext";
import { rowsByName, rowsByPath, splitName, type DetailsCard, type ReportRow } from "../view";

const GROUP_KEY = "zipkit.groupByName";

function savedGrouping(): boolean {
  try { return localStorage.getItem(GROUP_KEY) !== "off"; }
  catch { return true; }
}

type Item =
  | { kind: "heading"; key: string; text: string }
  | { kind: "row"; key: string; row: ReportRow; inGroup: boolean };

export function ItemListDialog({ card, onClose }: { card: DetailsCard; onClose: () => void }) {
  const t = useI18n();
  const [grouped, setGrouped] = useState(savedGrouping);
  const names = useMemo(() => rowsByName(card.rows), [card.rows]);
  // Grouping is offered only where it gathers something: a list of excluded
  // items in which some name occurs more than once.
  const groupable = card.groupable && names.repeated.length > 0;
  const byName = groupable && grouped;
  const choose = (next: boolean): void => {
    setGrouped(next);
    try { localStorage.setItem(GROUP_KEY, next ? "on" : "off"); } catch { /* remembered for this view only */ }
  };
  const items = useMemo((): Item[] => {
    if (!byName) return rowsByPath(card.rows).map((row, i) => ({ kind: "row", key: `p:${i}`, row, inGroup: false }));
    const { repeated, single } = names;
    return [
      ...repeated.flatMap((group, g): Item[] => [
        { kind: "heading", key: `h:${g}`, text: t.t("details.counted", { name: group.name, count: t.number(group.rows.length) }) },
        ...group.rows.map((row, i): Item => ({ kind: "row", key: `r:${g}:${i}`, row, inGroup: true })),
      ]),
      ...single.map((row, i): Item => ({ kind: "row", key: `s:${i}`, row, inGroup: false })),
    ];
  }, [byName, names, card.rows, t]);

  return (
    <ModalShell
      title={t.t("details.counted", { name: card.title, count: t.number(card.rows.length) })}
      onClose={onClose}
      width="min(48rem, 90vw)"
      footer={
        <>
          {groupable && (
            <label style={S.group}>
              <input type="checkbox" checked={grouped} onChange={(e) => choose(e.target.checked)} />
              {t.t("details.groupByName")}
            </label>
          )}
          <button data-modal-autofocus onClick={onClose}>{t.t("common.close")}</button>
        </>
      }
    >
      {card.about && <p style={S.about}>{card.about}</p>}
      {card.note && <p style={S.about}>{card.note}</p>}
      <VirtualRows items={items} rowDetail={card.rowDetail || card.groupable} />
    </ModalShell>
  );
}

function VirtualRows({ items, rowDetail }: { items: readonly Item[]; rowDetail: boolean }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => { setScrollElement(scrollParent(listRef.current)); }, []);
  // What is above the list can change height, so its start is measured on each render.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !scrollElement) return;
    const next = list.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop;
    if (next !== offset) setOffset(next);
  });
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElement,
    estimateSize: (index) => (items[index]!.kind === "heading" ? 30 : 48),
    getItemKey: (index) => items[index]!.key,
    scrollMargin: offset,
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
            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtual.start - offset}px)`, paddingBottom: "0.5rem" }}
          >
            {item.kind === "heading" ? (
              <h3 style={S.heading}>{item.text}</h3>
            ) : (
              <div style={item.inGroup ? S.groupedItem : S.item}>
                <span aria-hidden="true" style={S.bullet}>•</span>
                {/* In a group the heading names the item, so a row shows only where it is. */}
                {item.inGroup
                  ? <span style={S.groupedFolder}>{splitName(item.row.path).folder || item.row.path}</span>
                  : <ReportRowView row={item.row} variant="full" showChanges={rowDetail} />}
              </div>
            )}
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
  about: { margin: "0 0 0.75rem", fontSize: "0.85rem", color: "var(--text-2)" },
  // At the footer's start, away from Close.
  group: { display: "flex", alignItems: "center", gap: "0.45rem", marginInlineEnd: "auto", fontSize: "0.9rem" },
  heading: { margin: "0.4rem 0 0.2rem", fontSize: "0.85rem", fontWeight: 600 },
  item: { display: "grid", gridTemplateColumns: "1em minmax(0, 1fr)", alignItems: "baseline" },
  groupedItem: { display: "grid", gridTemplateColumns: "1em minmax(0, 1fr)", alignItems: "baseline", paddingInlineStart: "0.75rem" },
  bullet: { color: "var(--text-2)" },
  groupedFolder: { fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--text-2)", overflowWrap: "anywhere" },
};
