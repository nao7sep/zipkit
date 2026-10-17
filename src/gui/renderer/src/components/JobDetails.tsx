/**
 * The Details pane: the state of the selected job, its inputs and its archive,
 * as it is now, one card per kind of thing, the ones that block first and
 * each coloured by how much it matters. While the job works, the step it is on
 * leads. A card shows its first rows at once when it matters or is short; a
 * longer one unfolds in place, and every list opens in full, by path or by
 * name, for a user who wants to see each item before trusting ZipKit with the
 * originals. What happened to the job is said once, in the Archive pane's
 * history.
 */

import { memo, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { Job, JobEvent, PlanReport, VerifyResult } from "../../../shared/api";
import { useI18n } from "../i18n/I18nContext";
import { ItemListDialog } from "./ItemListDialog";
import { ReportRowView } from "./ReportRowView";
import {
  detailsCards,
  progressHeading,
  progressLineText,
  progressRuns,
  severityColor,
  type DetailsCard,
} from "../view";


/** Memoized: the window re-renders on every Progress batch, and the cards
 *  depend only on the job, the plan and the verification. */
export const JobDetails = memo(function JobDetails({
  job,
  plan,
  verify,
  events,
  rowLimit,
}: {
  job: Job;
  plan: PlanReport | null;
  verify: VerifyResult | null;
  events: readonly JobEvent[];
  /** A card with more rows than this shows its count; Details lists them. */
  rowLimit: number;
}) {
  const t = useI18n();
  const verifyData = verify?.ok ? verify.data : null;
  const cards = useMemo(() => detailsCards(job, plan, verifyData, t, rowLimit), [job, plan, verifyData, t, rowLimit]);
  const [open, setOpen] = useState<DetailsCard | null>(null);
  const busy = job.state === "planning" || job.state === "running" || job.trashing === true;
  const run = busy ? progressRuns(events).at(-1) : undefined;

  return (
    <div style={S.root}>
      {busy && (
        <section style={S.card} aria-label={t.t("details.working")}>
          {run && <div style={S.runHeading}>{progressHeading(run, t)}</div>}
          <div className="busy-bar" role="progressbar" aria-label={t.t("details.working")} />
          {run?.lines.slice(-3).map((line, i) => (
            <div key={i} style={S.runLine}>{progressLineText(line, t)}</div>
          ))}
        </section>
      )}
      {!busy && plan && cards.length === 0 && <p style={S.nothing}>{t.t("details.nothing")}</p>}
      {cards.map((card) => (
        <Card key={card.key} card={card} onOpen={setOpen} />
      ))}
      {open && <ItemListDialog card={open} onClose={() => setOpen(null)} />}
    </div>
  );
});

function Card({ card, onOpen }: { card: DetailsCard; onOpen: (card: DetailsCard) => void }) {
  const t = useI18n();
  const color = card.level === "info" ? undefined : severityColor(card.level);
  const count = card.rows.length;
  return (
    <section style={{ ...S.card, ...(color ? { borderColor: `color-mix(in srgb, ${color} 45%, var(--border))` } : null) }}>
      <div style={S.head}>
        <h3 style={S.heading}>
          <span style={{ ...S.title, color }}>{card.title}</span>
          {count > 0 && <span style={S.count}> {t.number(count)}</span>}
        </h3>
        {count > 0 && (
          <button
            type="button"
            className="text-button"
            aria-label={t.t("details.counted", { name: card.title, count: t.number(count) })}
            onClick={() => onOpen(card)}
          >
            {t.t("details.showList")}
          </button>
        )}
      </div>
      {card.note && <p style={S.note}>{card.note}</p>}
      {card.facts && (
        <dl style={S.facts}>
          {card.facts.map((fact) => (
            <div key={fact.label} style={S.fact}>
              <dt style={S.factLabel}>{fact.label}</dt>
              <dd style={S.factValue}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {card.open && count > 0 && (
        <ul style={S.list}>
          {card.rows.map((row, i) => (
            <li key={i} style={S.item}>
              <ReportRowView row={row} variant="line" showChanges={card.rowDetail} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const S: Record<string, CSSProperties> = {
  root: { display: "grid", gap: "0.75rem", alignContent: "start" },
  // A card is its own panel: a quiet edge, tinted by its level when it matters.
  card: {
    display: "grid",
    gap: "0.45rem",
    minWidth: 0,
    padding: "0.6rem 0.75rem",
    border: "1px solid var(--border)",
    borderRadius: 8,
  },
  runHeading: { color: "var(--text-2)", fontSize: "0.85rem" },
  runLine: { fontSize: "0.8rem", fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  nothing: { margin: 0, color: "var(--text-2)", fontSize: "0.85rem" },
  head: { display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: "0.15rem 0.75rem", minWidth: 0 },
  heading: { margin: 0, fontSize: "0.85rem", minWidth: 0 },
  title: { fontWeight: 600, color: "var(--text)" },
  count: { fontWeight: 400, color: "var(--text-2)" },
  note: { margin: 0, fontSize: "0.8rem", color: "var(--text-2)" },
  facts: { margin: 0, display: "grid", gap: "0.3rem" },
  fact: { display: "grid", gridTemplateColumns: "fit-content(40%) minmax(0, 1fr)", gap: "0.6rem", alignItems: "baseline" },
  factLabel: { fontSize: "0.8rem", color: "var(--text-2)" },
  factValue: { margin: 0, fontSize: "0.85rem", overflowWrap: "anywhere" },
  // Each item a bulleted line, so even a card of one reads as a list.
  list: { margin: 0, paddingInlineStart: "1.1rem", display: "grid", gap: "0.35rem" },
  item: { minWidth: 0 },
};
