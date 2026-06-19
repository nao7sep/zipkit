/**
 * The archive-parameters editor, shared by two surfaces: the Settings dialog
 * (where it edits the defaults for new jobs) and a selected job's Parameters
 * pane. It is a controlled view over the GuiOptions *knobs* — the cleaning,
 * manifest, compression, and comment choices; it does NOT own the output folder
 * or file name (those are operation-level and live with the Create action). The
 * SDK still owns all validation and every default not set here. Sections flow
 * into responsive columns so the whole set stays visible without a tall scroll.
 */

import type { CSSProperties, ReactNode } from "react";
import type { GuiOptions } from "../../../shared/spec";
import { multiline } from "../textCleanup";
import { FolderField } from "./FolderField";

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
    // The container establishes the query context; the fieldset is the grid that
    // responds to the *pane's* width (not the viewport), capping at 4 columns.
    <div className="options-grid-container">
      <fieldset disabled={disabled} className="options-grid" style={S.fieldset}>
      <Section title="Cleaning">
        <Check checked={options.junk} onChange={(v) => set("junk", v)}>
          Drop OS junk files
        </Check>
        <Check checked={options.strict} onChange={(v) => set("strict", v)}>
          Strict: block portability issues instead of auto-fixing
        </Check>
      </Section>

      <Section title="Manifest">
        <Check checked={options.metadata} onChange={(v) => set("metadata", v)}>
          Embed manifest (<code>_metadata.json</code>)
        </Check>
        <Check checked={options.hash} disabled={!options.metadata} onChange={(v) => set("hash", v)}>
          Record a per-file SHA-256
        </Check>
      </Section>

      <Section title="Archive">
        <Field label="Compression level (1–9)">
          <input
            type="number"
            min={1}
            max={9}
            value={options.level}
            onChange={(e) => set("level", Number(e.target.value))}
            style={{ width: "3.5rem" }}
          />
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

      {/* Where the archive is written. A normal column so it sits next to Archive
          when the pane is wide. The output folder and the overwrite policy belong
          together: both answer "where does the .zip land, and may it clobber?". */}
      <Section title="Output">
        <FolderField
          label="Output folder"
          value={options.outputDir}
          onChange={(v) => set("outputDir", v)}
          placeholder="(beside the input)"
        />
        <Check checked={options.overwrite} onChange={(v) => set("overwrite", v)}>
          Overwrite an existing file
        </Check>
      </Section>

      {/* A ZIP comment may span lines, so this is a multiline field cleaned on blur
          (commit-time, never mid-edit, IME-safe). Always its own full-width row. */}
      <Section title="Comment" wide>
        <textarea
          value={options.comment}
          rows={2}
          onChange={(e) => set("comment", e.target.value)}
          onBlur={(e) => set("comment", multiline(e.target.value))}
          style={S.textarea}
        />
      </Section>
      </fieldset>
    </div>
  );
}

function Section({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <div style={wide ? S.sectionWide : S.section}>
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
  // Just the <fieldset> reset; the responsive grid lives in `.options-grid`
  // (index.css) so it can use container queries to cap the column count.
  fieldset: { border: "none", margin: 0, padding: 0, minWidth: 0 },
  section: { display: "grid", gap: "0.4rem", minWidth: 0 },
  sectionWide: { display: "grid", gap: "0.4rem", minWidth: 0, gridColumn: "1 / -1" },
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
  // No fixed width and no wrap, so "Compression level" / "Empty directories" stay
  // on one line.
  fieldLabel: { whiteSpace: "nowrap", color: "var(--text-2)" },
  fieldControl: { display: "flex", gap: "0.5rem", alignItems: "center", flex: 1, minWidth: 0 },
  textarea: { width: "100%", resize: "vertical", fontFamily: "inherit", minHeight: "3rem" },
};
