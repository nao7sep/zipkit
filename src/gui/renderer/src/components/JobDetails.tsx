/**
 * The Details pane: what the user needs to see about the selected job when
 * they need it. While the job works, the step it is on; then what blocks it,
 * what to check, and what it leaves out or changes. Errors and warnings list
 * their first rows at once; exclusions fold into one line per reason and
 * renames into one line, since they ask nothing of the user. Every count opens
 * the full list, by path or by name, for a user who wants to see each item
 * before trusting ZipKit with the originals. What happened to the job is said
 * once, in the Archive pane's history.
 */

import { memo, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { Job, JobEvent, PlanReport, VerifyResult } from "../../../shared/api";
import { useI18n } from "../i18n/I18nContext";
import { ItemListDialog } from "./ItemListDialog";
import { ReportRowView } from "./ReportRowView";
import {
  DETAILS_INLINE_ROWS,
  detailsSections,
  planReport,
  progressHeading,
  progressLineText,
  progressRuns,
  rowsByReason,
  severityColor,
  type DetailsSection,
  type ReportRow,
} from "../view";

interface OpenList { title: string; rows: readonly ReportRow[] }

/** Memoized: the window re-renders on every Progress batch, and the sections
 *  depend only on the plan and the verification. */
export const JobDetails = memo(function JobDetails({
  job,
  plan,
  verify,
  events,
}: {
  job: Job;
  plan: PlanReport | null;
  verify: VerifyResult | null;
  events: readonly JobEvent[];
}) {
  const t = useI18n();
  const groups = useMemo(() => (plan ? planReport(plan, t) : []), [plan, t]);
  const verifyData = verify?.ok ? verify.data : null;
  const sections = useMemo(() => detailsSections(groups, verifyData, t), [groups, verifyData, t]);
  const [open, setOpen] = useState<OpenList | null>(null);
  const busy = job.state === "planning" || job.state === "running" || job.trashing === true;
  const run = busy ? progressRuns(events).at(-1) : undefined;

  return (
    <div style={S.root}>
      {busy && (
        <section style={S.working} aria-label={t.t("details.working")}>
          {run && <div style={S.runHeading}>{progressHeading(run, t)}</div>}
          <div className="busy-bar" role="progressbar" aria-label={t.t("details.working")} />
          {run?.lines.slice(-3).map((line, i) => (
            <div key={i} style={S.runLine}>{progressLineText(line, t)}</div>
          ))}
        </section>
      )}
      {!busy && plan && sections.length === 0 && <p style={S.nothing}>{t.t("details.nothing")}</p>}
      {sections.map((section) => (
        <Section key={section.key} section={section} onOpen={setOpen} />
      ))}
      {open && <ItemListDialog title={open.title} rows={open.rows} onClose={() => setOpen(null)} />}
    </div>
  );
});

function Section({ section, onOpen }: { section: DetailsSection; onOpen: (list: OpenList) => void }) {
  const t = useI18n();
  const color = section.level === "info" ? undefined : severityColor(section.level);
  const title = t.t("details.counted", { name: section.label, count: t.number(section.rows.length) });
  const more = section.show !== "rows" || section.rows.length > DETAILS_INLINE_ROWS;
  return (
    <section style={S.section}>
      {/* The heading wraps rather than squeezing beside its link: on a narrow
          pane the link drops to the line below. */}
      <div style={S.head}>
        <h3 style={{ ...S.title, color }}>
          {section.label} <span style={S.count}>{t.number(section.rows.length)}</span>
        </h3>
        {more && (
          <button type="button" className="text-button" aria-label={title} onClick={() => onOpen({ title, rows: section.rows })}>
            {t.t("details.showList")}
          </button>
        )}
      </div>
      {section.show === "rows" && (
        <div style={S.rows}>
          {section.rows.slice(0, DETAILS_INLINE_ROWS).map((row, i) => (
            <ReportRowView key={i} row={row} variant="line" />
          ))}
        </div>
      )}
      {section.show === "reasons" && (
        <ul style={S.reasons}>
          {rowsByReason(section.rows).map(({ reason, rows }) => {
            const listTitle = t.t("details.counted", { name: reason, count: t.number(rows.length) });
            return (
              <li key={reason} style={S.reason}>
                <span style={S.reasonText}>
                  {reason} <span style={S.count}>{t.number(rows.length)}</span>
                </span>
                <button type="button" className="text-button" aria-label={listTitle} onClick={() => onOpen({ title: listTitle, rows })}>
                  {t.t("details.showList")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const S: Record<string, CSSProperties> = {
  root: { display: "grid", gap: "1rem", alignContent: "start" },
  working: { display: "grid", gap: "0.35rem" },
  runHeading: { color: "var(--text-2)", fontSize: "0.85rem" },
  runLine: { fontSize: "0.8rem", fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word" },
  nothing: { margin: 0, color: "var(--text-2)", fontSize: "0.85rem" },
  section: { display: "grid", gap: "0.4rem", minWidth: 0 },
  head: { display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: "0.15rem 0.75rem", minWidth: 0 },
  title: { margin: 0, fontSize: "0.85rem", fontWeight: 600, minWidth: 0 },
  count: { fontWeight: 400, color: "var(--text-2)" },
  rows: { display: "grid", gap: "0.5rem" },
  reasons: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.35rem" },
  reason: { display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: "0.15rem 0.75rem", fontSize: "0.85rem", minWidth: 0 },
  reasonText: { minWidth: 0 },
};
