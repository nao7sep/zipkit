/**
 * A labelled output-folder field: a text input plus a native "Choose…" folder
 * picker. Used for the per-job output folder and the default output folder in
 * Settings. The value is an absolute directory (or empty to write beside the
 * input); the picker fills it from the OS dialog. Stacked (label above the row)
 * so it sits cleanly in a column.
 */

import type { CSSProperties } from "react";

export function FolderField({
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
          disabled={disabled}
          onClick={() => void window.zipkit.chooseOutputDir().then((dir) => dir && onChange(dir))}
        >
          Choose…
        </button>
      </span>
    </label>
  );
}

const S: Record<string, CSSProperties> = {
  stack: { display: "grid", gap: "0.25rem", minWidth: 0 },
  label: { color: "var(--text-2)", fontSize: "0.85rem" },
  row: { display: "flex", gap: "0.4rem", minWidth: 0 },
  input: { flex: 1, minWidth: 0 },
};
