/**
 * One row of a job's lists, shared by the Details pane and the full-list
 * dialog so a row reads the same in both. No rule or bar marks it: the
 * section heading carries the colour, and space separates the rows.
 *
 * - `line` (the pane): the path on one line, keeping its name and giving up
 *   its folders first, then what happens to it.
 * - `full` (the dialog): the name, with a rename's removed and added
 *   characters marked, its folder dimmed below, then what happens to it.
 */

import type { CSSProperties } from "react";
import { useI18n } from "../i18n/I18nContext";
import { PathText } from "./PathText";
import { renameDisplay, splitName, type ReportRow } from "../view";

export function ReportRowView({
  row,
  variant,
  showFolder = true,
  showChanges = true,
}: {
  row: ReportRow;
  variant: "line" | "full";
  showFolder?: boolean;
  showChanges?: boolean;
}) {
  const { name, folder } = splitName(row.path);
  return (
    <div style={S.row}>
      {variant === "line" ? (
        <span style={S.mono} title={row.path}><PathText path={row.path} /></span>
      ) : (
        <>
          <RowName row={row} name={name} />
          {showFolder && folder && <span style={S.folder}>{folder}</span>}
        </>
      )}
      {showChanges && row.changes.map((change, i) => (
        <span key={i} style={S.change}>{change}</span>
      ))}
    </div>
  );
}

/** A row's name, with a rename's removed and added characters marked. The
 *  marks are visual only; a screen reader hears the name and the path it had
 *  on disk. */
function RowName({ row, name }: { row: ReportRow; name: string }) {
  const t = useI18n();
  const shown = row.from === undefined ? null : renameDisplay(splitName(row.from).name, name);
  if (row.from === undefined || shown === null || shown.kind === "same") {
    return <span style={S.name}>{name}</span>;
  }
  return (
    <span style={S.name}>
      <span style={S.srOnly}>{name} </span>
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
  row: { display: "flex", flexDirection: "column", minWidth: 0 },
  mono: { display: "block", fontFamily: "var(--font-mono)", fontSize: "0.8rem", minWidth: 0 },
  // A name wraps only where it must, never splitting a word it can keep whole.
  name: { fontFamily: "var(--font-mono)", fontSize: "0.8rem", overflowWrap: "anywhere" },
  folder: { fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--text-2)", overflowWrap: "anywhere" },
  change: { fontSize: "0.8rem", color: "var(--text-2)", overflowWrap: "anywhere" },
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
