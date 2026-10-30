/**
 * A field where the user types a whole number (number-field conventions). The
 * text stays exactly as typed: nothing clamps, rounds or restores it, so the
 * input is plain text rather than a number input, which would adopt or drop a
 * partial value. The parent holds the text, commits only what
 * `parseWholeNumber` accepts, and holds back the action that would use the
 * value while it is not; `WholeNumberIssue` under the field says what it takes.
 */

import type { CSSProperties } from "react";
import { isWholeNumberIn, type WholeNumberRange } from "../../../shared/spec";
import { useI18n } from "../i18n/I18nContext";

/** The number the text names, or null when it is empty, not a whole number or
 *  out of range. Full-width digits from an IME read as their ASCII digits. */
export function parseWholeNumber(text: string, range: WholeNumberRange): number | null {
  const digits = text.normalize("NFKC").trim();
  if (!/^[0-9]+$/.test(digits)) return null;
  const value = Number(digits);
  return isWholeNumberIn(value, range) ? value : null;
}

export function WholeNumberInput({
  text,
  range,
  onText,
  issueId,
  disabled,
  style,
}: {
  text: string;
  range: WholeNumberRange;
  onText: (text: string) => void;
  /** The id of the `WholeNumberIssue` shown while the text is not usable. */
  issueId: string;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const invalid = parseWholeNumber(text, range) === null;
  return (
    <input
      type="text"
      inputMode="numeric"
      spellCheck={false}
      value={text}
      disabled={disabled}
      aria-invalid={invalid ? true : undefined}
      aria-describedby={invalid ? issueId : undefined}
      onChange={(e) => onText(e.target.value)}
      style={style}
    />
  );
}

export function WholeNumberIssue({ id, range, style }: { id: string; range: WholeNumberRange; style?: CSSProperties }) {
  const { t } = useI18n();
  return <p id={id} className="inline-issue" style={style}>{t("options.wholeNumber", { min: range.min, max: range.max })}</p>;
}
