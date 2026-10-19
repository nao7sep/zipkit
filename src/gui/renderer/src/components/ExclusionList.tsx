/**
 * The exclusion-pattern editor on Settings' Exclusion patterns tab: the whole
 * list new jobs leave out, in the order it is checked. Each row holds a
 * pattern, its dialect, what it applies to, whether case matters and a label;
 * rows are added, moved and removed, and the list resets to the one ZipKit
 * ships with. A row that cannot be used (empty, or a regex that does not
 * compile) is marked and named in the issues, and Save waits for it.
 */

import type { CSSProperties } from "react";
import type { ExclusionPattern } from "zipkitsdk/types";
import { useI18n } from "../i18n/I18nContext";
import { CloseIcon, MoveIcon } from "./Icon";

/** What is wrong with a row, or null. */
export type PatternIssue = "empty" | "regex";

export function patternIssue(p: ExclusionPattern): PatternIssue | null {
  if (p.pattern === "") return "empty";
  if (p.match === "regex") {
    try { new RegExp(p.pattern); } catch { return "regex"; }
  }
  return null;
}

/** The list with one row moved from `from` to `to`. */
function moved(list: readonly ExclusionPattern[], from: number, to: number): ExclusionPattern[] {
  const next = [...list];
  const [row] = next.splice(from, 1);
  next.splice(to, 0, row!);
  return next;
}

export function ExclusionList({
  patterns,
  onChange,
  disabled,
}: {
  patterns: readonly ExclusionPattern[];
  onChange: (patterns: ExclusionPattern[]) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const update = (row: number, change: Partial<ExclusionPattern>): void => {
    onChange(patterns.map((p, i) => {
      if (i !== row) return p;
      const next = { ...p, ...change };
      // An empty label is no label.
      if (next.label !== undefined && next.label.trim() === "") delete next.label;
      return next;
    }));
  };
  const issues = patterns.map(patternIssue);

  return (
    <div style={S.list}>
      {patterns.length === 0 && <p style={S.empty}>{t("exclusions.empty")}</p>}
      <ol style={S.rows} aria-label={t("exclusions.listLabel")}>
        {patterns.map((p, row) => {
          const number = row + 1;
          const issue = issues[row];
          const issueId = `exclusion-issue-${row}`;
          return (
            <li key={row} style={S.row}>
              <input
                style={S.pattern}
                value={p.pattern}
                spellCheck={false}
                disabled={disabled}
                aria-label={t("exclusions.pattern", { number })}
                aria-invalid={issue ? true : undefined}
                aria-describedby={issue ? issueId : undefined}
                onChange={(e) => update(row, { pattern: e.target.value })}
              />
              <input
                style={S.label}
                value={p.label ?? ""}
                placeholder={t("exclusions.labelPlaceholder")}
                disabled={disabled}
                aria-label={t("exclusions.label", { number })}
                onChange={(e) => update(row, { label: e.target.value })}
              />
              <div style={S.controls}>
                <select
                  value={p.match}
                  disabled={disabled}
                  aria-label={t("exclusions.match", { number })}
                  onChange={(e) => update(row, { match: e.target.value as ExclusionPattern["match"] })}
                >
                  <option value="glob">{t("exclusions.glob")}</option>
                  <option value="regex">{t("exclusions.regex")}</option>
                </select>
                <select
                  value={p.target}
                  disabled={disabled}
                  aria-label={t("exclusions.target", { number })}
                  onChange={(e) => update(row, { target: e.target.value as ExclusionPattern["target"] })}
                >
                  <option value="both">{t("exclusions.targetBoth")}</option>
                  <option value="file">{t("exclusions.targetFiles")}</option>
                  <option value="dir">{t("exclusions.targetFolders")}</option>
                </select>
                <label style={S.check}>
                  <input
                    type="checkbox"
                    checked={p.ignoreCase}
                    disabled={disabled}
                    onChange={(e) => update(row, { ignoreCase: e.target.checked })}
                  />
                  {t("exclusions.ignoreCase")}
                </label>
                <span style={S.buttons}>
                  <button type="button" style={S.icon} disabled={disabled || row === 0}
                    aria-label={t("exclusions.moveUp", { number })} title={t("exclusions.moveUp", { number })}
                    onClick={() => onChange(moved(patterns, row, row - 1))}>
                    <MoveIcon direction="up" />
                  </button>
                  <button type="button" style={S.icon} disabled={disabled || row === patterns.length - 1}
                    aria-label={t("exclusions.moveDown", { number })} title={t("exclusions.moveDown", { number })}
                    onClick={() => onChange(moved(patterns, row, row + 1))}>
                    <MoveIcon direction="down" />
                  </button>
                  <button type="button" style={S.icon} disabled={disabled}
                    aria-label={t("exclusions.remove", { number })} title={t("exclusions.remove", { number })}
                    onClick={() => onChange(patterns.filter((_, i) => i !== row))}>
                    <CloseIcon />
                  </button>
                </span>
              </div>
              {issue && (
                <span id={issueId} role="alert" style={S.issue}>
                  {t(issue === "empty" ? "exclusions.issueEmpty" : "exclusions.issueRegex", { number })}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <div>
        <button type="button" disabled={disabled}
          onClick={() => onChange([...patterns, { pattern: "", match: "glob", target: "both", ignoreCase: false }])}>
          {t("exclusions.add")}
        </button>
      </div>
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  list: { display: "grid", gap: "0.6rem" },
  empty: { margin: 0, color: "var(--text-2)" },
  rows: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.5rem" },
  // The pattern and its label on one line, the rest below, wrapping at need.
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)",
    gap: "0.35rem 0.5rem",
    paddingBottom: "0.5rem",
    borderBottom: "1px solid var(--border)",
  },
  pattern: { minWidth: 0, fontFamily: "var(--font-mono)" },
  label: { minWidth: 0 },
  controls: { gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.4rem 0.75rem" },
  check: { display: "flex", alignItems: "center", gap: "0.35rem" },
  buttons: { display: "flex", gap: "0.25rem", marginLeft: "auto" },
  icon: { display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: "var(--control-h)" },
  issue: { gridColumn: "1 / -1", color: "var(--status-error)", fontSize: "0.85em" },
};
