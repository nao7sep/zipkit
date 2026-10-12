/**
 * A labelled output-directory field: a text input plus a native "Choose" picker.
 * Used for the per-job output directory and the default output directory in
 * Settings. The value is an absolute directory (or empty to write beside the
 * input). Edits immediately reach the parent: Settings owns its modal draft,
 * and main owns job saves and debounces planning. Stacked so it fits a column.
 */

import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import { reportableError } from "../externalDropBoundary";
import { ReceiverResultNotice } from "./ReceiverResultNotice";
import { useI18n } from "../i18n/I18nContext";
import { message } from "../../../shared/i18n/translate";

export function DirectoryField({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const [pickerError, setPickerError] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const pickerPending = useRef(false);
  const change = useRef(onChange);
  change.current = onChange;

  async function chooseDirectory() {
    if (pickerPending.current) return;
    pickerPending.current = true;
    setIsPicking(true);
    setPickerError(false);
    try {
      const dir = await window.zipkit.chooseOutputDir();
      // A picker can settle after other options were edited. Use the current
      // parent callback rather than the options snapshot at the initial click.
      if (dir) change.current(dir);
    } catch (error) {
      window.zipkit.reportError("choose output directory", reportableError(error));
      setPickerError(true);
    } finally {
      pickerPending.current = false;
      setIsPicking(false);
    }
  }

  return (
    <label style={S.stack}>
      <span style={S.label}>{label}</span>
      <span style={S.row}>
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          style={S.input}
        />
        <button
          disabled={disabled || isPicking}
          onClick={() => void chooseDirectory()}
        >
          {t("common.choose")}
        </button>
      </span>
      {pickerError && <ReceiverResultNotice result={{ message: message("directory.pickerFailed"), severity: "error" }} onDismiss={() => setPickerError(false)} />}
    </label>
  );
}

const S: Record<string, CSSProperties> = {
  stack: { display: "grid", gap: "0.25rem", minWidth: 0 },
  label: { color: "var(--text-2)", fontSize: "0.85rem" },
  row: { display: "flex", gap: "0.4rem", minWidth: 0 },
  input: { flex: 1, minWidth: 0 },
};
