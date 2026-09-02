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

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Job, PlanData, VerifyResult } from "../../../shared/api";
import {
  jobAdvisories,
  humanSentence,
  planReport,
  reportSummary,
  severityColor,
  verifySummary,
  type ReportLine,
} from "../view";

export function Report({
  job,
  plan,
  verify,
}: {
  job: Job;
  plan: PlanData | null;
  verify: VerifyResult | null;
}) {
  const summary = reportSummary(job, plan);
  // GUI advisories about the inputs (e.g. re-zipping a .zip) lead the log — they
  // are relevant before any plan exists, so they keep the report from reading
  // "No report yet" when there's genuinely something to say.
  const advisories = jobAdvisories(job);
  const lines = plan ? planReport(plan) : [];

  const noReport = !plan && !summary && advisories.length === 0;

  const verifyData = verify?.ok ? verify.data : null;
  const verifyLines: ReportLine[] = verifyData
    ? [
        ...(verifyData.missing.length > 0
          ? [{ level: "error" as const, text: `Missing from the archive: ${verifyData.missing.join(", ")}` }]
          : []),
        ...(verifyData.extra.length > 0
          ? [{ level: "warning" as const, text: `Unexpected extra entries: ${verifyData.extra.join(", ")}` }]
          : []),
      ]
    : [];

  const verificationResult = verify
    ? verify.ok
      ? {
          level: verify.data.reportOk ? "info" as const : "error" as const,
          text: verify.data.reportOk
            ? `Verified — ${verifySummary(verify.data)}`
            : `Verification failed — ${verifySummary(verify.data)}`,
        }
      : {
          level: "error" as const,
          text: verify.error.presentation,
        }
    : null;

  const priorResults = useRef<{ summary: string; action: string; verification: string } | null>(null);
  const [assertiveAnnouncement, setAssertiveAnnouncement] = useState("");
  const [politeAnnouncement, setPoliteAnnouncement] = useState("");
  const summarySignature = summary ? `${summary.level}|${summary.text}` : "";
  const actionSignature = job.actionResult
    ? `${job.actionResult.severity}|${job.actionResult.message}`
    : "";
  const verificationSignature = verificationResult
    ? `${verificationResult.level}|${verificationResult.text}`
    : "";
  const summaryAnnouncement = summary
    ? { level: summary.level, text: summary.text }
    : null;
  const actionAnnouncement = job.actionResult
    ? { level: job.actionResult.severity, text: job.actionResult.message }
    : null;

  // The Report remounts when selection changes, so its first render establishes
  // a silent baseline. Only later result transitions announce; selecting a job,
  // restoring existing results, and ordinary report rows remain quiet.
  useEffect(() => {
    const current = {
      summary: summarySignature,
      action: actionSignature,
      verification: verificationSignature,
    };
    const previous = priorResults.current;
    priorResults.current = current;
    if (!previous) return;

    const changed = [
      { before: previous.summary, after: current.summary, result: summaryAnnouncement },
      { before: previous.action, after: current.action, result: actionAnnouncement },
      { before: previous.verification, after: current.verification, result: verificationResult },
    ];
    if (!changed.some(({ before, after }) => before !== after)) return;

    let candidate: { level: ReportLine["level"]; text: string } | null = null;
    for (const item of changed) {
      if (item.before !== item.after && item.result) {
        if (!candidate || item.result.level === "error" || candidate.level !== "error") {
          candidate = item.result;
        }
      }
    }

    if (!candidate) {
      setAssertiveAnnouncement("");
      setPoliteAnnouncement("");
    } else if (candidate.level === "error") {
      setPoliteAnnouncement("");
      setAssertiveAnnouncement(candidate.text);
    } else {
      setAssertiveAnnouncement("");
      setPoliteAnnouncement(candidate.text);
    }
  }, [actionSignature, summarySignature, verificationSignature]);

  return (
    <div>
      {noReport && <p style={S.muted}>No report yet.</p>}
      {summary && (
        <p style={{ ...S.summary, color: severityColor(summary.level) }}>
          {summary.text}
        </p>
      )}
      {job.state === "done" && job.message && <p style={S.note}>{humanSentence(job.message)}</p>}
      {job.actionResult && (
        <p style={{ ...S.note, color: severityColor(job.actionResult.severity) }}>
          {job.actionResult.message}
        </p>
      )}
      {verificationResult && (
        <p style={{ ...S.note, color: severityColor(verificationResult.level) }}>
          {verificationResult.text}
        </p>
      )}
      {plan && lines.length === 0 && plan.writable && (
        <p style={S.note}>Everything is clean — nothing needed fixing.</p>
      )}
      {(advisories.length > 0 || lines.length > 0 || verifyLines.length > 0) && (
        <ul style={S.log}>
          {advisories.map((line, i) => (
            <LogRow key={`a${i}`} line={line} />
          ))}
          {lines.map((line, i) => (
            <LogRow key={`f${i}`} line={line} />
          ))}
          {verifyLines.map((line, i) => (
            <LogRow key={`v${i}`} line={line} />
          ))}
        </ul>
      )}
      <span aria-live="assertive" aria-atomic="true" style={S.srOnly}>
        {assertiveAnnouncement}
      </span>
      <span aria-live="polite" aria-atomic="true" style={S.srOnly}>
        {politeAnnouncement}
      </span>
    </div>
  );
}

function LogRow({ line }: { line: ReportLine }) {
  return (
    <li style={{ ...S.row, borderColor: severityColor(line.level) }}>
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
  row: {
    display: "flex",
    alignItems: "baseline",
    minWidth: 0,
    borderLeft: "2px solid",
    paddingLeft: "0.55rem",
  },
  text: { flex: 1, minWidth: 0, fontSize: "0.85rem", wordBreak: "break-word" },
  path: { color: "var(--text-2)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.8rem" },
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
