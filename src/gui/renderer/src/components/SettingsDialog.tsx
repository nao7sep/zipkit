/**
 * Settings dialog (modal-dialog conventions): the defaults applied to every new
 * job. These are set-once-ish, not per-archive knobs, which is why they live here
 * rather than on the main screen.
 *
 * This is a draft form, not a live-apply surface: edits accumulate in a local
 * draft and commit only on Save (disabled until the draft is both dirty and
 * valid), per the conventions' draft-versus-committed rule. Closing with unsaved
 * edits — via Cancel, Escape, or the backdrop — routes through one guard that
 * asks before discarding them. A job's own options can still override these
 * defaults later in its Parameters pane.
 */

import { useState } from "react";
import type { CSSProperties } from "react";
import { ModalShell } from "./ModalShell";
import { OptionsPanel } from "./OptionsPanel";
import { useConfirm } from "./DialogHost";
import { DEFAULT_OPTIONS, type GuiOptions, type GuiSettings, type ThemePreference } from "../../../shared/spec";
import { reportableError } from "../externalDropBoundary";
import { useI18n } from "../i18n/I18nContext";
import type { MessageKey } from "../../../shared/i18n/catalogues";
import { CATALOGUES } from "../../../shared/i18n/catalogues";
import { LANGUAGES, normalizeLanguagePreference } from "../../../shared/i18n/languages";

/** Two option sets are equal when every visible field matches — the draft's
 *  dirty check (flat record, so a key-wise compare is exact). */
function optionsEqual(a: GuiOptions, b: GuiOptions): boolean {
  return (Object.keys(DEFAULT_OPTIONS) as (keyof GuiOptions)[]).every((k) => a[k] === b[k]);
}

/** Settings are equal when the option defaults, the UI font, the theme, and the
 *  language all match. */
function settingsEqual(a: GuiSettings, b: GuiSettings): boolean {
  return (
    a.uiFontFamily === b.uiFontFamily &&
    a.theme === b.theme &&
    a.language === b.language &&
    optionsEqual(a.defaults, b.defaults)
  );
}

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: MessageKey }> = [
  { value: "system", label: "settings.themeSystem" },
  { value: "light", label: "settings.themeLight" },
  { value: "dark", label: "settings.themeDark" },
];

/** The only field that can be made invalid from the UI: the compression level. */
function isValid(o: GuiOptions): boolean {
  return Number.isInteger(o.level) && o.level >= 1 && o.level <= 9;
}

export function SettingsDialog({
  settings,
  onSave,
  onClose,
}: {
  settings: GuiSettings;
  onSave: (s: GuiSettings) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<GuiSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const dirty = !settingsEqual(draft, settings);
  const canSave = dirty && isValid(draft.defaults);

  async function save() {
    setSaving(true);
    setSaveError(false);
    try {
      await onSave(draft);
      onClose();
    } catch (err) {
      window.zipkit.reportError("save settings", reportableError(err));
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  // Named for exactly what it resets, so the label and the code agree
  // (config-seeding conventions) — "default parameters" is the same phrase the
  // main window's per-job toggle uses for these knobs. It only rewrites the
  // unsaved draft — Save commits it, closing without saving keeps the current
  // settings — so the label is the whole warning and no confirmation is needed.
  // The UI font, the theme, and the language are deliberately left alone: they
  // are the user's own preferences, not built-ins that go stale, so a reset
  // must not drag them along.
  function resetDefaultParameters() {
    setDraft({ ...draft, defaults: { ...DEFAULT_OPTIONS } });
  }

  // One close guard for every dismissal path (Cancel button, Escape, backdrop):
  // ask before throwing away unsaved edits; close immediately when clean.
  async function requestClose() {
    if (!dirty) {
      onClose();
      return;
    }
    const discard = await confirm({
      title: t("settings.discardTitle"),
      message: t("settings.discardMessage"),
      confirmLabel: t("settings.discard"),
      danger: true,
    });
    if (discard) onClose();
  }

  return (
    <ModalShell
      title={t("settings.title")}
      onClose={() => void requestClose()}
      maxWidth="44rem"
      footer={
        // Cancel is first in DOM so the shell's footer-first focus lands on the
        // safe default, never on the reset (which would rewrite the draft on a
        // stray Enter) or the primary Save. The reset button is visually pulled
        // to the far left (flex order + auto margin); Save stays last per the
        // conventions' order.
        <>
          <button onClick={() => void requestClose()}>{t("common.cancel")}</button>
          <button style={S.resetDefaultParameters} onClick={resetDefaultParameters}>
            {t("settings.resetDefaults")}
          </button>
          <button className="accent" disabled={!canSave || saving} onClick={() => void save()}>
            {t(saving ? "settings.saving" : "common.save")}
          </button>
        </>
      }
    >
      {/* Each language is listed by its own name, in its own script, so a reader
          of any of them can find it whatever language is showing. Staged in the
          draft and applied on Save like the rest. */}
      <label style={S.fontField}>
        <span style={S.fontLabel}>{t("settings.language")}</span>
        <select
          value={draft.language}
          onChange={(e) => setDraft({ ...draft, language: normalizeLanguagePreference(e.target.value) })}
          style={S.languageSelect}
        >
          <option value="system">{t("settings.languageSystem")}</option>
          {LANGUAGES.map((language) => (
            <option key={language} value={language} lang={language}>
              {CATALOGUES[language]["language.name"] as string}
            </option>
          ))}
        </select>
      </label>
      {/* Appearance: the theme and the UI (chrome) font, set apart from the per-job
          archive knobs below. The theme is a native radio group (one tab stop, arrow keys
          move and select), staged in the draft and applied on Save like the rest. */}
      <fieldset style={S.themeField}>
        <legend style={S.themeLegend}>{t("settings.theme")}</legend>
        <div style={S.themeOptions}>
          {THEME_OPTIONS.map(({ value, label }) => (
            <label key={value} style={S.themeOption}>
              <input
                type="radio"
                name="theme"
                value={value}
                checked={draft.theme === value}
                onChange={() => setDraft({ ...draft, theme: value })}
              />
              {t(label)}
            </label>
          ))}
        </div>
        <span style={S.fontHint}>{t("settings.themeHint")}</span>
      </fieldset>
      <label style={S.fontField}>
        <span style={S.fontLabel}>{t("settings.uiFont")}</span>
        <input
          value={draft.uiFontFamily}
          placeholder={t("settings.uiFontDefault")}
          onChange={(e) => setDraft({ ...draft, uiFontFamily: e.target.value })}
        />
        <span style={S.fontHint}>{t("settings.uiFontHint")}</span>
      </label>
      <OptionsPanel
        options={draft.defaults}
        onChange={(o) => setDraft({ ...draft, defaults: o })}
        disabled={false}
      />
      {saveError && <p role="alert" style={S.error}>{t("settings.saveFailed")}</p>}
    </ModalShell>
  );
}

const S: Record<string, CSSProperties> = {
  // Reset sits at the far left of the footer, apart from the Cancel/Save pair:
  // the auto margin pushes those two right, the order pulls it ahead of Cancel
  // (which stays first in DOM for the shell's footer-first focus).
  resetDefaultParameters: { order: -1, marginRight: "auto" },
  themeField: { display: "flex", flexDirection: "column", gap: "0.35rem", margin: "0 0 1rem", padding: 0, border: "none", minWidth: 0 },
  themeLegend: { fontWeight: 600, padding: 0, marginBottom: "0.35rem" },
  themeOptions: { display: "flex", flexWrap: "wrap", gap: "0.35rem 1.25rem" },
  themeOption: { display: "flex", alignItems: "center", gap: "0.4rem" },
  fontField: { display: "flex", flexDirection: "column", gap: "0.35rem", marginBottom: "1rem" },
  fontLabel: { fontWeight: 600 },
  // As wide as the longest language name or "System" in any language, never a
  // fixed width a translation would clip.
  languageSelect: { alignSelf: "flex-start", minWidth: "12rem" },
  fontHint: { fontSize: "0.85em", color: "var(--text-2)" },
  error: { color: "var(--status-error)", marginBottom: 0 },
};
