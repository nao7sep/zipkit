/**
 * One row of a job's lists: its archive path, with a rename's removed and added
 * characters marked, and what happens to it. Shared by the Details pane and the
 * full-list dialog, so a row reads the same in both.
 */

import type { CSSProperties } from "react";
import { useI18n } from "../i18n/I18nContext";
import { renameDisplay, type ReportRow } from "../view";

export function ReportRowView({ row, color, showChanges = true }: { row: ReportRow; color: string; showChanges?: boolean }) {
  return (
    <div style={{ ...S.row, borderColor: color }}>
      <RowPath row={row} />
      {showChanges && row.changes.map((change, i) => (
        <span key={i} style={S.change}>{change}</span>
      ))}
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

export const S: Record<string, CSSProperties> = {
  row: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    borderLeft: "2px solid",
    paddingLeft: "0.55rem",
  },
  change: { fontSize: "0.8rem", color: "var(--text-2)", wordBreak: "break-word" },
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
