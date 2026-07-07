/**
 * A labelled output-directory field: a text input plus a native "Choose" picker.
 * Used for the per-job output directory and the default output directory in
 * Settings. The value is an absolute directory (or empty to write beside the
 * input). It commits on blur (and on pick), not on every keystroke, so typing a
 * path does not trigger a dry run per character — the parent re-plans once, when
 * the field is left. Stacked (label above the row) so it sits cleanly in a column.
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

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
  const [draft, setDraft] = useState(value);
  // Resync the draft only when the value changes from outside (picker, restore
  // defaults) — not echoing back our own committed edits.
  const committed = useRef(value);
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);

  function commit(next: string) {
    committed.current = next;
    setDraft(next);
    onChange(next);
  }

  return (
    <label style={S.stack}>
      <span style={S.label}>{label}</span>
      <span style={S.row}>
        <input
          type="text"
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          style={S.input}
        />
        <button
          disabled={disabled}
          onClick={() => void window.zipkit.chooseOutputDir().then((dir) => dir && commit(dir))}
        >
          Choose
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
