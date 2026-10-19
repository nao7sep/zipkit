/**
 * The exclusion-pattern editor on Settings' Exclusion patterns tab: the whole
 * list new jobs leave out, in the order it is checked. Each row's first line
 * holds the pattern, its dialect, what it applies to, whether case matters and
 * the row's buttons; its second line holds an optional note across the full
 * width, growing to more lines only when its text needs them. A note is never
 * matched; a built-in pattern's description, in the interface language, is its
 * placeholder. Rows are added, moved and removed, and the list resets to the
 * one ZipKit ships with. Under the config-sets conventions' typed-list rule, a
 * blank row is not a pattern and is dropped on save ({@link cleanExclusions}),
 * and a row that fails its check, a regular expression that does not compile,
 * carries its own message and holds Save.
 */

import { useId, type CSSProperties } from "react";
import type { ExclusionPattern } from "zipkitsdk/types";
import { useI18n } from "../i18n/I18nContext";
import { CloseIcon, MatchCaseIcon, MoveIcon } from "./Icon";
import { builtInDescription } from "../../../shared/exclusions";

/** A row's text without the spaces typed around it. Only spaces and tabs go:
 *  a control character can be part of a real name, as the carriage return in
 *  macOS's `Icon` file is. */
function trimmed(text: string): string {
  return text.replace(/^[ \t]+|[ \t]+$/g, "");
}

/** Whether a row fails its check: a regular expression that does not
 *  compile. A blank row is no pattern at all, not a failing one. */
export function patternInvalid(p: ExclusionPattern): boolean {
  const pattern = trimmed(p.pattern);
  if (p.match !== "regex" || pattern === "") return false;
  try { new RegExp(pattern); return false; } catch { return true; }
}

/** The list as it is saved: each pattern and note trimmed, blank rows and
 *  blank notes dropped. */
export function cleanExclusions(list: readonly ExclusionPattern[]): ExclusionPattern[] {
  return list.flatMap((p) => {
    const pattern = trimmed(p.pattern);
    if (pattern === "") return [];
    const { note, ...rest } = p;
    const kept = note === undefined ? undefined : trimmed(note);
    return [{ ...rest, pattern, ...(kept ? { note: kept } : {}) }];
  });
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
      return { ...p, ...change };
    }));
  };
  const invalid = patterns.map(patternInvalid);
  const idBase = useId();

  return (
    <div style={S.list}>
      {patterns.length === 0 && <p style={S.empty}>{t("exclusions.empty")}</p>}
      <ol style={S.rows} aria-label={t("exclusions.listLabel")}>
        {patterns.map((p, row) => {
          const number = row + 1;
          const issue = invalid[row];
          const issueId = `${idBase}-issue-${row}`;
          return (
            <li key={row} style={S.row}>
              {/* First line: the pattern and how it matches, with the row's
                  buttons; second line: its note across the full width. */}
              <div style={S.line}>
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
                {/* A toggle drawn as editors' familiar "Aa" mark, pressed when
                    case matters, so the line keeps room for the pattern. */}
                <button type="button" style={p.ignoreCase ? S.caseToggle : { ...S.caseToggle, ...S.casePressed }} disabled={disabled}
                  aria-pressed={!p.ignoreCase}
                  aria-label={t("exclusions.matchCase", { number })} title={t("exclusions.matchCase", { number })}
                  onClick={() => update(row, { ignoreCase: !p.ignoreCase })}>
                  <MatchCaseIcon />
                </button>
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
              {/* One line of text that takes a second line, and more, only when
                  the note or the description in its place needs them: a text
                  area sized to its content, with Enter and pasted line breaks
                  kept out, since a note is a single line. */}
              <textarea
                style={S.note}
                rows={1}
                value={p.note ?? ""}
                placeholder={t(builtInDescription(p) ?? "exclusions.notePlaceholder")}
                disabled={disabled}
                aria-label={t("exclusions.note", { number })}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) e.preventDefault(); }}
                onChange={(e) => update(row, { note: e.target.value.replace(/[\r\n]+/g, " ") })}
              />
              {/* Tied to its field, not announced on every keystroke
                  (operation-result conventions, field association). */}
              {issue && <p id={issueId} className="inline-issue" style={S.issue}>{t("exclusions.issueRegex")}</p>}
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
  row: { display: "grid", gap: "0.35rem", paddingBottom: "0.5rem", borderBottom: "1px solid var(--border)" },
  line: { display: "flex", alignItems: "center", gap: "0.4rem", minWidth: 0 },
  pattern: { flex: "1 1 8rem", minWidth: 0, fontFamily: "var(--font-mono)" },
  // `field-sizing: content` grows the area to its text or, when empty, its
  // placeholder; one line is its least.
  note: { width: "100%", boxSizing: "border-box", resize: "none", minHeight: "var(--control-h)", fieldSizing: "content" } as CSSProperties,
  caseToggle: { flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: "var(--control-h)", color: "var(--text-2)", background: "transparent" },
  casePressed: { color: "var(--text)", background: "var(--surface-2)", borderColor: "var(--field-border)" },
  buttons: { display: "flex", gap: "0.25rem", flexShrink: 0 },
  icon: { display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: "var(--control-h)" },
  issue: { margin: 0 },
};
