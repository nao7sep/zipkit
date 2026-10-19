/**
 * The archive-parameters editor, shared by two surfaces: the Settings dialog
 * (where it edits the defaults for new jobs) and a selected job's Parameters
 * pane. It is a controlled view over the archive parameters — cleaning, manifest
 * and compression. Where the archive goes, its name, whether it may replace a
 * file and its comment belong to one job and live with the Create action.
 * The SDK still owns all validation and every default not set here. Sections flow
 * into responsive columns so the whole set stays visible without a tall scroll.
 */

import type { CSSProperties, ReactNode } from "react";
import type { ArchiveParameters } from "../../../shared/spec";
import { useI18n } from "../i18n/I18nContext";

export function OptionsPanel({
  options,
  onChange,
  disabled,
}: {
  options: ArchiveParameters;
  /** Every edit reaches the parent that owns its saving policy. */
  onChange: (o: ArchiveParameters) => void;
  disabled: boolean;
}) {
  const { t, rich } = useI18n();
  const set = <K extends keyof ArchiveParameters>(key: K, value: ArchiveParameters[K]) =>
    onChange({ ...options, [key]: value });

  return (
    // The fieldset is the grid; its columns follow the pane's width.
    <fieldset disabled={disabled} className="options-grid" style={S.fieldset}>
      <Section title={t("options.cleaning")}>
        <Check checked={options.junk} onChange={(v) => set("junk", v)}>
          {t("options.junk")}
        </Check>
        <Check checked={options.strict} onChange={(v) => set("strict", v)}>
          {t("options.strict")}
        </Check>
        {/* Strict makes these characters block the archive, so how they would
            be replaced does not apply then. */}
        <Field label={t("options.invalidChars")}>
          <select
            style={S.select}
            value={options.invalidChars}
            disabled={options.strict}
            onChange={(e) => set("invalidChars", e.target.value as ArchiveParameters["invalidChars"])}
          >
            <option value="tidy">{t("options.invalidCharsTidy")}</option>
            <option value="replace">{t("options.invalidCharsReplace")}</option>
            <option value="fullwidth">{t("options.invalidCharsFullwidth")}</option>
            <option value="remove">{t("options.invalidCharsRemove")}</option>
          </select>
        </Field>
      </Section>

      <Section title={t("options.manifest")}>
        <Check checked={options.manifest} onChange={(v) => set("manifest", v)}>
          {rich("options.embedManifest", { file: <code>zipkit.json</code> })}
        </Check>
        <Check checked={options.hash} disabled={!options.manifest} onChange={(v) => set("hash", v)}>
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
            style={S.select}
            value={options.symlinks}
            onChange={(e) => set("symlinks", e.target.value as ArchiveParameters["symlinks"])}
          >
            <option value="ignore">{t("options.symlinksIgnore")}</option>
            <option value="preserve">{t("options.symlinksPreserve")}</option>
            <option value="follow">{t("options.symlinksFollow")}</option>
          </select>
        </Field>
        <Field label={t("options.emptyDirs")}>
          <select
            style={S.select}
            value={options.emptyDirs}
            onChange={(e) => set("emptyDirs", e.target.value as ArchiveParameters["emptyDirs"])}
          >
            <option value="keep">{t("options.emptyDirsKeep")}</option>
            <option value="prune">{t("options.emptyDirsPrune")}</option>
          </select>
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
  // Just the <fieldset> reset; the responsive grid lives in `.options-grid`
  // (index.css).
  fieldset: { border: "none", margin: 0, padding: 0, minWidth: 0 },
  section: { display: "grid", gap: "0.4rem", minWidth: 0 },
  sectionTitle: {
    fontSize: "0.75rem",
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-2)",
  },
  sectionBody: { display: "grid", gap: "0.4rem" },
  check: { display: "flex", gap: "0.5rem", alignItems: "baseline" },
  // Label and control side by side while they fit; otherwise the control wraps
  // below the label, and a label longer than the column wraps itself.
  field: { display: "flex", flexWrap: "wrap", gap: "0.3rem 0.6rem", alignItems: "center", minWidth: 0 },
  fieldLabel: { color: "var(--text-2)", minWidth: 0 },
  fieldControl: { display: "flex", gap: "0.5rem", alignItems: "center", flex: "1 1 auto", minWidth: 0 },
  // A select can then shrink below its longest option instead of overflowing.
  select: { minWidth: 0, maxWidth: "100%" },
};
