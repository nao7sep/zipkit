/**
 * Details of one Status card: what this kind of thing is and what ZipKit does
 * about it, what every item has in common said once, then every item by where
 * it is on disk, for a user who wants to see each one before trusting ZipKit with
 * the originals. The card itself groups by name; here every path stands
 * alone. The list is virtualized (volume-handling conventions, Item count):
 * only the rows in or near the view are drawn, however many there are.
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ModalShell } from "./ModalShell";
import { ReportRowView } from "./ReportRowView";
import { useI18n } from "../i18n/I18nContext";
import { rowsByPath, type DetailsCard, type ReportRow } from "../view";

export function ItemListDialog({ card, onClose }: { card: DetailsCard; onClose: () => void }) {
  const t = useI18n();
  const rows = useMemo(() => rowsByPath(card.rows, t.locale), [card.rows, t.locale]);
  return (
    <ModalShell
      title={card.countless ? card.title : t.t("details.counted", { name: card.title, count: t.number(card.rows.length) })}
      onClose={onClose}
      width="min(48rem, 90vw)"
      footer={<button data-modal-autofocus onClick={onClose}>{t.t("common.close")}</button>}
    >
      {card.about && <p style={S.about}>{card.about}</p>}
      {card.note && <p style={S.about}>{card.note}</p>}
      {/* What a warning or an error says alike for every item — often what to
          do — is said once; an informational card's title already says it. */}
      {card.common && card.level !== "info" && <p style={S.common}>{card.common}</p>}
      <VirtualRows rows={rows} showChanges={!card.common} />
    </ModalShell>
  );
}

function VirtualRows({ rows, showChanges }: { rows: readonly ReportRow[]; showChanges: boolean }) {
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
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => (showChanges ? 44 : 26),
    scrollMargin: offset,
    overscan: 8,
    initialRect: { width: 0, height: window.innerHeight },
  });
  return (
    <div ref={listRef} style={{ position: "relative", height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((virtual) => (
        <div
          key={virtual.key}
          data-index={virtual.index}
          ref={virtualizer.measureElement}
          style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtual.start - offset}px)`, paddingBottom: "0.4rem" }}
        >
          <div style={S.item}>
            <span aria-hidden="true" style={S.bullet}>•</span>
            <ReportRowView row={rows[virtual.index]!} showChanges={showChanges} />
          </div>
        </div>
      ))}
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
  common: { margin: "0 0 0.75rem", fontSize: "0.85rem" },
  item: { display: "grid", gridTemplateColumns: "1em minmax(0, 1fr)", alignItems: "baseline" },
  bullet: { color: "var(--text-2)" },
};
