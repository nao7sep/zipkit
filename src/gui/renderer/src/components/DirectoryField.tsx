/**
 * A labelled per-job output directory with a native picker. Blank keeps the
 * archive beside its inputs; picker context never writes a default into it.
 * Edits reach main's job-save owner immediately, which debounces planning.
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
  inputs,
  fileName,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  inputs?: string[];
  fileName?: string;
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
      const dir = await window.zipkit.chooseOutputDir(value, inputs, fileName);
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

  // Two cells of the pane's control grid: the label beside the field while the
  // pane is wide enough, above it when it is not (`.control-grid`, index.css).
  return (
    <label className="control-grid__item">
      <span className="control-grid__label">{label}</span>
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
      {pickerError && (
        <span className="control-grid__control">
          <ReceiverResultNotice result={{ message: message("directory.pickerFailed"), severity: "error" }} onDismiss={() => setPickerError(false)} />
        </span>
      )}
    </label>
  );
}

const S: Record<string, CSSProperties> = {
  row: { display: "flex", gap: "0.4rem", minWidth: 0 },
  input: { flex: 1, minWidth: 0 },
};
