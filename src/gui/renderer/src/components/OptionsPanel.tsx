/**
 * The archive-parameters editor, shared by two surfaces: the Settings dialog
 * (where it edits the defaults for new jobs) and a selected job's Parameters
 * pane. It is a controlled view over the GuiOptions *knobs* — cleaning, manifest,
 * compression, comment, and the output directory + overwrite group; it does NOT
 * own the file name (that is operation-level and lives with the Create action).
 * The SDK still owns all validation and every default not set here. Sections flow
 * into responsive columns so the whole set stays visible without a tall scroll.
 */

import type { CSSProperties, ReactNode } from "react";
import type { GuiOptions } from "../../../shared/spec";
import { multiline } from "../textCleanup";
import { DirectoryField } from "./DirectoryField";
import { useI18n } from "../i18n/I18nContext";

export function OptionsPanel({
  options,
  onChange,
  disabled,
}: {
  options: GuiOptions;
  onChange: (o: GuiOptions) => void;
  disabled: boolean;
}) {
  const { t, rich } = useI18n();
  const set = <K extends keyof GuiOptions>(key: K, value: GuiOptions[K]) =>
    onChange({ ...options, [key]: value });

  return (
    // The container establishes the query context; the fieldset is the grid that
    // responds to the *pane's* width (not the viewport), capping at 4 columns.
    <div className="options-grid-container">
      <fieldset disabled={disabled} className="options-grid" style={S.fieldset}>
      <Section title={t("options.cleaning")}>
        <Check checked={options.junk} onChange={(v) => set("junk", v)}>
          {t("options.junk")}
        </Check>
        <Check checked={options.strict} onChange={(v) => set("strict", v)}>
          {t("options.strict")}
        </Check>
      </Section>

      <Section title={t("options.manifest")}>
        <Check checked={options.metadata} onChange={(v) => set("metadata", v)}>
          {rich("options.embedManifest", { file: <code>_metadata.json</code> })}
        </Check>
        <Check checked={options.hash} disabled={!options.metadata} onChange={(v) => set("hash", v)}>
          {t("options.hash")}
        </Check>
      </Section>

      <Section title={t("options.archive")}>
        <Field label={t("options.level")}>
          <input
            type="number"
            min={1}
            max={9}
            value={options.level}
            onChange={(e) => set("level", Number(e.target.value))}
            style={{ width: "3.5rem" }}
          />
        </Field>
        <Field label={t("options.symlinks")}>
          <select
            value={options.symlinks}
            onChange={(e) => set("symlinks", e.target.value as GuiOptions["symlinks"])}
          >
            <option value="ignore">{t("options.symlinksIgnore")}</option>
            <option value="preserve">{t("options.symlinksPreserve")}</option>
            <option value="follow">{t("options.symlinksFollow")}</option>
          </select>
        </Field>
        <Field label={t("options.emptyDirs")}>
          <select
            value={options.emptyDirs}
            onChange={(e) => set("emptyDirs", e.target.value as GuiOptions["emptyDirs"])}
          >
            <option value="keep">{t("options.emptyDirsKeep")}</option>
            <option value="prune">{t("options.emptyDirsPrune")}</option>
          </select>
        </Field>
      </Section>

      {/* Where the archive is written. A normal column so it sits next to Archive
          when the pane is wide. The output directory and the overwrite policy
          belong together: both answer "where does the .zip land, and may it
          clobber?". */}
      <Section title={t("options.output")}>
        <DirectoryField
          label={t("options.outputDir")}
          value={options.outputDir}
          onChange={(v) => set("outputDir", v)}
          placeholder={t("dest.besideInput")}
        />
        <Check checked={options.overwrite} onChange={(v) => set("overwrite", v)}>
          {t("options.overwrite")}
        </Check>
      </Section>

      {/* A ZIP comment may span lines, so this is a multiline field cleaned on blur
          (commit-time, never mid-edit, IME-safe). Always its own full-width row. */}
      <Section title={t("options.comment")} wide>
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
    fontSize: "0.75rem",
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
