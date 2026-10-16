/**
 * The control panel's account of the job: one line on what blocks it or what
 * it will do, then what has happened to it, oldest first, so the user can read
 * it through before removing the originals. A new line in the history, or a
 * changed digest, is announced once: an error assertively, anything else
 * politely. The pane remounts for each selected job, so selecting one, and the
 * history it already has, stay quiet.
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Job } from "../../../shared/api";
import { useI18n } from "../i18n/I18nContext";
import { severityColor, type ReportLine } from "../view";

export function JobDigest({ job, digest }: { job: Job; digest: ReportLine | null }) {
  const t = useI18n();
  const history = job.history ?? [];
  const [assertive, setAssertive] = useState("");
  const [polite, setPolite] = useState("");
  const digestSignature = digest ? `${digest.level}|${digest.text}` : "";
  const latest = history.at(-1);
  const latestText = latest ? t.text(latest.message) : "";
  const prior = useRef<{ digest: string; count: number } | null>(null);
  useEffect(() => {
    const current = { digest: digestSignature, count: history.length };
    const previous = prior.current;
    prior.current = current;
    if (!previous) return;
    const said: ReportLine | null = current.count > previous.count && latest
      ? { level: latest.severity, text: latestText }
      : current.digest !== previous.digest ? digest : null;
    if (!said) return;
    if (said.level === "error") {
      setPolite("");
      setAssertive(said.text);
    } else {
      setAssertive("");
      setPolite(said.text);
    }
  }, [digestSignature, history.length]);

  return (
    <>
      {digest && (
        <p className="text-line" style={{ ...S.digest, color: severityColor(digest.level) }} title={digest.text}>
          {digest.text}
        </p>
      )}
      {history.length > 0 && (
        <ul style={S.history} aria-label={t.t("history.label")}>
          {history.map((entry, index) => (
            <li key={index} style={entry.severity === "info" ? undefined : { color: severityColor(entry.severity) }}>
              {t.text(entry.message)}
            </li>
          ))}
        </ul>
      )}
      <span aria-live="assertive" aria-atomic="true" style={S.srOnly}>{assertive}</span>
      <span aria-live="polite" aria-atomic="true" style={S.srOnly}>{polite}</span>
    </>
  );
}

const S: Record<string, CSSProperties> = {
  // The whole sentence is in its tooltip; the history says the rest.
  digest: { margin: "0.6rem 0 0", fontSize: "0.85rem" },
  history: { margin: "0.6rem 0 0", paddingInlineStart: "1.2rem", display: "grid", gap: "0.2rem", fontSize: "0.85rem" },
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
