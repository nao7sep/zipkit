/**
 * The archive-options editor, shared by two surfaces: the Settings dialog (where
 * it edits the defaults for new jobs) and a selected job's overrides pane. It is
 * a controlled view over GuiOptions — it renders the visible option state and
 * reports changes; the SDK still owns all validation and every default not set
 * here. Grouped into sections so the set reads as related choices rather than a
 * flat wall of inputs.
 */

import type { CSSProperties, ReactNode } from "react";
import type { GuiOptions } from "../../../shared/spec";

export function OptionsPanel({
  options,
  onChange,
  disabled,
}: {
  options: GuiOptions;
  onChange: (o: GuiOptions) => void;
  disabled: boolean;
}) {
  const set = <K extends keyof GuiOptions>(key: K, value: GuiOptions[K]) =>
    onChange({ ...options, [key]: value });

  return (
    <fieldset disabled={disabled} style={S.fieldset}>
      <Section title="Cleaning">
        <Check checked={options.junk} onChange={(v) => set("junk", v)}>
          Drop OS junk files
        </Check>
        <Check checked={options.strict} onChange={(v) => set("strict", v)}>
          Strict — block portability issues instead of auto-fixing
        </Check>
      </Section>

      <Section title="Manifest">
        <Check checked={options.metadata} onChange={(v) => set("metadata", v)}>
          Embed manifest (<code>_metadata.json</code>)
        </Check>
        <Check
          checked={options.hash}
          disabled={!options.metadata}
          onChange={(v) => set("hash", v)}
        >
          Record a per-file SHA-256
        </Check>
      </Section>

      <Section title="Archive">
        <Field label="Compression level">
          <input
            type="number"
            min={1}
            max={9}
            value={options.level}
            onChange={(e) => set("level", Number(e.target.value))}
            style={{ width: "3.5rem" }}
          />
          <span style={S.hint}>1–9</span>
        </Field>
        <Field label="Symlinks">
          <select
            value={options.symlinks}
            onChange={(e) => set("symlinks", e.target.value as GuiOptions["symlinks"])}
          >
            <option value="ignore">ignore</option>
            <option value="preserve">preserve</option>
            <option value="follow">follow</option>
          </select>
        </Field>
        <Field label="Empty directories">
          <select
            value={options.emptyDirs}
            onChange={(e) => set("emptyDirs", e.target.value as GuiOptions["emptyDirs"])}
          >
            <option value="keep">keep</option>
            <option value="prune">prune</option>
          </select>
        </Field>
      </Section>

      <Section title="Output">
        <Field label="Path">
          <input
            type="text"
            placeholder="(beside the input)"
            value={options.output}
            onChange={(e) => set("output", e.target.value)}
            style={{ flex: 1, minWidth: 0 }}
          />
        </Field>
        <Check checked={options.overwrite} onChange={(v) => set("overwrite", v)}>
          Overwrite an existing file
        </Check>
        <Field label="Comment">
          <input
            type="text"
            value={options.comment}
            onChange={(e) => set("comment", e.target.value)}
            style={{ flex: 1, minWidth: 0 }}
          />
        </Field>
      </Section>
    </fieldset>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={S.section}>
      <div style={S.sectionTitle}>{title}</div>
      <div style={S.sectionBody}>{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={S.field}>
      <span style={S.fieldLabel}>{label}</span>
      <span style={S.fieldControl}>{children}</span>
    </label>
  );
}

function Check({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label style={{ ...S.check, opacity: disabled ? 0.5 : 1 }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

const S: Record<string, CSSProperties> = {
  // Sections flow into as many columns as fit (1–3 on typical widths), so the
  // whole option set stays visible without a tall scroll on a modest monitor.
  fieldset: {
    border: "none",
    margin: 0,
    padding: 0,
    minWidth: 0,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(15rem, 1fr))",
    gap: "1rem 1.5rem",
    alignItems: "start",
  },
  section: { display: "grid", gap: "0.4rem", minWidth: 0 },
  sectionTitle: {
    fontSize: "0.7rem",
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-2)",
  },
  sectionBody: { display: "grid", gap: "0.4rem" },
  check: { display: "flex", gap: "0.5rem", alignItems: "baseline" },
  field: { display: "flex", gap: "0.6rem", alignItems: "center" },
  fieldLabel: { width: "6.5rem", flexShrink: 0, color: "var(--text-2)" },
  fieldControl: { display: "flex", gap: "0.5rem", alignItems: "center", flex: 1, minWidth: 0 },
  hint: { color: "var(--text-2)", fontSize: "0.8rem" },
};
