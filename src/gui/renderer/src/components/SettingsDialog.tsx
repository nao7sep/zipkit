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
 *
 * While a save runs, the fields and every close path are disabled until it
 * actually settles, which normally takes milliseconds: the dialog then closes on
 * success or stays open with the error. A later quit-time retry updates committed
 * preferences and clears that error without replacing this editor's newer draft.
 */

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { ModalShell } from "./ModalShell";
import { OptionsPanel } from "./OptionsPanel";
import { useConfirm } from "./DialogHost";
import { changedSettings, DEFAULT_OPTIONS, type GuiOptions, type GuiSettings, type ThemePreference } from "../../../shared/spec";
import { singleLine } from "../../../shared/textCleanup";
import { reportableError } from "../externalDropBoundary";
import { useI18n } from "../i18n/I18nContext";
import type { MessageKey } from "../../../shared/i18n/catalogues";
import { LANGUAGE_NAMES, LANGUAGES, normalizeLanguagePreference } from "../../../shared/i18n/languages";

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: MessageKey }> = [
  { value: "system", label: "settings.themeSystem" },
  { value: "light", label: "settings.themeLight" },
  { value: "dark", label: "settings.themeDark" },
];

/** The built-in UI font stack, read from the stylesheet that owns it, shown as the
 *  empty field's placeholder (config-sets conventions, In the interface). */
function builtInFontStack(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--font-ui-default").trim();
}

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
  onSave: (settings: GuiSettings) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<GuiSettings>(settings);
  const [fontStack] = useState(builtInFontStack);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);

  // A quit Retry can commit while this editor remains open. Clear the obsolete
  // failure message without replacing any newer, unsubmitted draft edits.
  useEffect(() => { setSaveError(false); },
    [settings.defaults, settings.uiFontFamily, settings.theme, settings.language]);

  const dirty = Object.keys(changedSettings(settings, draft)).length > 0;
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

  // A draft action (config-sets conventions, Reset). "Default parameters" is the
  // main window's own phrase for these knobs. The language, the theme and the UI
  // font are the user's preferences, not tuned built-ins, so they stay as they are.
  function resetDefaultParameters() {
    setDraft({ ...draft, defaults: { ...DEFAULT_OPTIONS } });
  }

  // One close guard for every dismissal path (Cancel button, Escape, backdrop):
  // ask before throwing away unsaved edits; close immediately when clean.
  async function requestClose() {
    if (saving) return;
    if (!dirty) {
      await discardAndClose();
      return;
    }
    const discard = await confirm({
      title: t("settings.discardTitle"),
      message: t("settings.discardMessage"),
      confirmLabel: t("settings.discard"),
      cancelLabel: t("common.keepEditing"),
      danger: true,
    });
    if (discard) await discardAndClose();
  }

  async function discardAndClose() {
    try {
      await window.zipkit.discardSettingsSubmission();
      onClose();
    } catch (err) {
      window.zipkit.reportError("discard settings submission", reportableError(err));
      setSaveError(true);
    }
  }

  return (
    <ModalShell
      title={t("settings.title")}
      onClose={() => void requestClose()}
      maxWidth="44rem"
      footer={
        // Initial focus is named on Cancel (modal-dialog conventions), never the
        // reset or Save. The reset is pulled to the far left (flex order + auto
        // margin); Save stays last.
        <>
          <button data-modal-autofocus disabled={saving} onClick={() => void requestClose()}>{t("common.cancel")}</button>
          <button style={S.resetDefaultParameters} disabled={saving} onClick={resetDefaultParameters}>
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
          disabled={saving}
          onChange={(e) => setDraft({ ...draft, language: normalizeLanguagePreference(e.target.value) })}
          style={S.languageSelect}
        >
          <option value="system">{t("settings.languageSystem")}</option>
          {LANGUAGES.map((language) => (
            <option key={language} value={language} lang={language}>
              {LANGUAGE_NAMES[language]}
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
                disabled={saving}
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
          disabled={saving}
          placeholder={fontStack}
          onChange={(e) => setDraft({ ...draft, uiFontFamily: e.target.value })}
          onBlur={(e) => setDraft({ ...draft, uiFontFamily: singleLine(e.target.value) })}
        />
        <span style={S.fontHint}>{t("settings.uiFontHint")}</span>
      </label>
      <OptionsPanel
        options={draft.defaults}
        onChange={(o) => setDraft({ ...draft, defaults: o })}
        disabled={saving}
      />
      {saveError && <p role="alert" style={S.error}>{t("settings.saveFailed")}</p>}
    </ModalShell>
  );
}

const S: Record<string, CSSProperties> = {
  // Reset sits at the far left of the footer, apart from the Cancel/Save pair:
  // the auto margin pushes those two right, the order pulls it ahead of Cancel.
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
