/**
 * The job report: a context-aware, human-readable log of what the archive will do
 * (or did) for the user — names normalized, junk excluded, issues that block —
 * each line colored by level (info / warning / error). No corner "verdict" badge,
 * nothing folded: a dropped or renamed path is exactly what the user must see, so
 * every line is always visible. The verify result, when present, joins the same
 * log. Verdict/derivations are pure (`reportSummary` / `planReport` in view); this
 * just renders. The parent clears stale state (verify, the plan) at the right
 * times, so the report never shows a result that no longer holds.
 */

import type { CSSProperties } from "react";
import type { ExtractData, Job, PlanData } from "../../../shared/api";
import { planReport, reportSummary, severityColor, severityLabel, verifySummary, type ReportLine } from "../view";

export function Report({
  job,
  plan,
  verify,
}: {
  job: Job;
  plan: PlanData | null;
  verify: ExtractData | null;
}) {
  const summary = reportSummary(job, plan);
  const lines = plan ? planReport(plan) : [];

  if (!plan && !summary) return <p style={S.muted}>No report yet.</p>;

  const verifyLines: ReportLine[] = verify
    ? [
        {
          level: verify.reportOk ? "info" : "error",
          text: verify.reportOk
            ? `Verified — ${verifySummary(verify)}`
            : `Verification failed — ${verifySummary(verify)}`,
        },
        ...(verify.missing.length > 0
          ? [{ level: "error" as const, text: `Missing from the archive: ${verify.missing.join(", ")}` }]
          : []),
        ...(verify.extra.length > 0
          ? [{ level: "warning" as const, text: `Unexpected extra entries: ${verify.extra.join(", ")}` }]
          : []),
      ]
    : [];

  return (
    <div>
      {summary && <p style={{ ...S.summary, color: severityColor(summary.level) }}>{summary.text}</p>}
      {job.state === "done" && job.message && <p style={S.note}>{job.message}</p>}
      {plan && lines.length === 0 && plan.writable && (
        <p style={S.note}>Everything is clean — nothing needed fixing.</p>
      )}
      {(lines.length > 0 || verifyLines.length > 0) && (
        <ul style={S.log}>
          {lines.map((line, i) => (
            <LogRow key={`f${i}`} line={line} />
          ))}
          {verifyLines.map((line, i) => (
            <LogRow key={`v${i}`} line={line} />
          ))}
        </ul>
      )}
    </div>
  );
}

function LogRow({ line }: { line: ReportLine }) {
  return (
    <li style={S.row}>
      <span style={{ ...S.tag, color: severityColor(line.level) }}>{severityLabel(line.level)}</span>
      <span style={S.text}>
        {line.text}
        {line.path && <span style={S.path}> {line.path}</span>}
      </span>
    </li>
  );
}

const S: Record<string, CSSProperties> = {
  muted: { color: "var(--text-2)", margin: "0.4rem 0" },
  summary: { margin: "0 0 0.5rem", fontSize: "0.95rem", fontWeight: 600 },
  note: { color: "var(--text-2)", margin: "0 0 0.5rem", fontSize: "0.85rem" },
  log: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.3rem" },
  row: { display: "flex", gap: "0.6rem", alignItems: "baseline", minWidth: 0 },
  // Fixed-width colored level tag so the messages line up into a scannable column.
  tag: { flexShrink: 0, width: "4rem", fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase" },
  text: { flex: 1, minWidth: 0, fontSize: "0.85rem", wordBreak: "break-word" },
  path: { color: "var(--text-2)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.8rem" },
};
