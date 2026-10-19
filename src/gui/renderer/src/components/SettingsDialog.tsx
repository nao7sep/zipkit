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
 * Three tabs: General (the app's own preferences), New job parameters, and
 * Exclusion patterns, the list new jobs leave out, edited whole. Each group
 * has its own reset; Save covers every tab.
 *
 * While a save runs, the fields and every close path are disabled until it
 * actually settles, which normally takes milliseconds: the dialog then closes on
 * success or stays open with the error. A later quit-time retry updates committed
 * preferences and clears that error without replacing this editor's newer draft.
 */

import { useEffect, useState } from "react";
import { DEFAULT_EXCLUSIONS } from "zipkitsdk/defaults";
import { cleanExclusions, ExclusionList, patternInvalid } from "./ExclusionList";
import { useTablist } from "../useTablist";
import type { CSSProperties } from "react";
import { ModalShell } from "./ModalShell";
import { OptionsPanel } from "./OptionsPanel";
import { useConfirm } from "./DialogHost";
import { CARD_ROW_LIMIT_RANGE, changedSettings, DEFAULT_PARAMETERS, displayZones, isCardRowLimit, type ArchiveParameters, type GuiSettings, type ThemePreference } from "../../../shared/spec";
import type { SystemChoices } from "../../../shared/api";
import { singleLine } from "../../../shared/textCleanup";
import { reportableError } from "../externalDropBoundary";
import { useI18n } from "../i18n/I18nContext";
import type { MessageKey } from "../../../shared/i18n/catalogues";
import { LANGUAGE_NAMES, LANGUAGES, normalizeLanguagePreference, type Language } from "../../../shared/i18n/languages";

const THEME_LABELS: Readonly<Record<Exclude<ThemePreference, "system">, MessageKey>> = {
  light: "settings.themeLight",
  dark: "settings.themeDark",
};
const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];

/** A language's name in the interface language, for the System entry, whose word
 *  and value both speak it (localization-conventions, Translation). The picker's
 *  own entries name each language in itself instead. Each shipped variety is its
 *  language's only one, so it is named plainly, as the picker does. */
export function languageNameIn(language: Language, interfaceLanguage: Language): string {
  const plain = language.split("-")[0]!;
  return new Intl.DisplayNames([interfaceLanguage], { type: "language" }).of(plain) ?? LANGUAGE_NAMES[language];
}

/** The built-in UI font stack, read from the stylesheet that owns it, shown as the
 *  empty field's placeholder (config-sets conventions, In the interface). */
function builtInFontStack(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--font-ui-default").trim();
}

/** The fields that can be made invalid from the UI: the compression level, the
 *  manifest name and the exclusion patterns. */
function isValid(o: ArchiveParameters): boolean {
  return Number.isInteger(o.level) && o.level >= 1 && o.level <= 9 &&
    o.manifestName.trim() !== "" && !o.exclusions.some(patternInvalid);
}

const TABS = ["general", "parameters", "exclusions"] as const;
type SettingsTab = (typeof TABS)[number];
const TAB_LABELS: Readonly<Record<SettingsTab, MessageKey>> = {
  general: "settings.tabGeneral",
  parameters: "settings.newJobParameters",
  exclusions: "settings.tabExclusions",
};

/** Every System entry names what it resolves to now, such as "System (Dark)"
 *  (app-chrome conventions, Theme; timestamp conventions, Time zones); the opener
 *  asks main for `system` before showing the dialog. */
export function SettingsDialog({
  settings,
  system,
  onSave,
  onClose,
}: {
  settings: GuiSettings;
  system: SystemChoices;
  onSave: (settings: GuiSettings) => Promise<void>;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<GuiSettings>(settings);
  const [fontStack] = useState(builtInFontStack);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [tab, setTab] = useState<SettingsTab>("general");
  const tablist = useTablist({ tabs: TABS, selected: tab, onSelect: setTab, idBase: "settings" });

  // A quit Retry can commit while this editor remains open. Clear the obsolete
  // failure message without replacing any newer, unsubmitted draft edits.
  useEffect(() => { setSaveError(false); },
    [settings.defaults, settings.uiFontFamily, settings.theme, settings.language, settings.timeZone, settings.confirmJobRemoval, settings.cardRowLimit]);

  // What Save would store: blank pattern rows dropped and the rest trimmed, so
  // a row added and left blank neither dirties the draft nor reaches disk.
  const saved: GuiSettings = { ...draft, defaults: { ...draft.defaults, exclusions: cleanExclusions(draft.defaults.exclusions) } };
  const dirty = Object.keys(changedSettings(settings, saved)).length > 0;
  // Quit asks before discarding unsaved edits, so main follows whether there are any.
  useEffect(() => { window.zipkit.reportSettingsDraft(dirty); }, [dirty]);
  useEffect(() => () => window.zipkit.reportSettingsDraft(false), []);
  const canSave = dirty && isValid(draft.defaults) && isCardRowLimit(draft.cardRowLimit);

  async function save() {
    setSaving(true);
    setSaveError(false);
    try {
      await onSave(saved);
      onClose();
    } catch (err) {
      window.zipkit.reportError("save settings", reportableError(err));
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  // Draft actions (config-sets conventions, Reset), one per group: the
  // parameters, or the exclusion patterns, go back to the initial values ZipKit
  // ships with. The language, the theme and the UI font are the user's
  // preferences, not tuned built-ins, so they stay as they are.
  function resetDefaultParameters() {
    setDraft({ ...draft, defaults: { ...DEFAULT_PARAMETERS, exclusions: draft.defaults.exclusions } });
  }
  function resetExclusions() {
    setDraft({ ...draft, defaults: { ...draft.defaults, exclusions: DEFAULT_EXCLUSIONS.map((p) => ({ ...p })) } });
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
      width="min(44rem, calc(100vw - 2rem))"
      footer={
        // Initial focus is named on Cancel (modal-dialog conventions), never Save.
        <>
          <button data-modal-autofocus disabled={saving} onClick={() => void requestClose()}>{t("common.cancel")}</button>
          <button className="accent" disabled={!canSave || saving} onClick={() => void save()}>
            {t(saving ? "settings.saving" : "common.save")}
          </button>
        </>
      }
    >
      <div {...tablist.tablistProps} aria-label={t("settings.sections")} style={S.tabs}>
        {TABS.map((value) => (
          <button key={value} {...tablist.tabProps(value)} style={value === tab ? { ...S.tab, ...S.tabActive } : S.tab}>
            {t(TAB_LABELS[value])}
          </button>
        ))}
      </div>
      <div {...tablist.panelProps("general")} hidden={tab !== "general"}>
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
            <option value="system">{t("settings.system", { value: languageNameIn(system.language, language) })}</option>
            {LANGUAGES.map((language) => (
              <option key={language} value={language} lang={language}>
                {LANGUAGE_NAMES[language]}
              </option>
            ))}
          </select>
        </label>
        {/* The zone every time in the app is shown in. Chosen from the platform's
            zones, never typed; System follows the computer's zone each launch. */}
        <label style={S.fontField}>
          <span style={S.fontLabel}>{t("settings.timeZone")}</span>
          <select
            value={draft.timeZone}
            disabled={saving}
            onChange={(e) => setDraft({ ...draft, timeZone: e.target.value })}
            style={S.languageSelect}
          >
            <option value="system">{t("settings.system", { value: system.timeZone })}</option>
            {/* A saved zone the platform lists under another name still shows as chosen. */}
            {draft.timeZone !== "system" && !displayZones().includes(draft.timeZone) && (
              <option value={draft.timeZone}>{draft.timeZone}</option>
            )}
            {displayZones().map((zone) => (
              <option key={zone} value={zone}>{zone}</option>
            ))}
          </select>
        </label>
        {/* Appearance: the theme and the UI (chrome) font, set apart from the per-job
            archive knobs below. The theme is a native radio group (one tab stop, arrow keys
            move and select), staged in the draft and applied on Save like the rest. */}
        <fieldset style={S.themeField}>
          <legend style={S.themeLegend}>{t("settings.theme")}</legend>
          <div style={S.themeOptions}>
            {THEMES.map((value) => (
              <label key={value} style={S.themeOption}>
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  checked={draft.theme === value}
                  disabled={saving}
                  onChange={() => setDraft({ ...draft, theme: value })}
                />
                {value === "system"
                  ? t("settings.system", { value: t(THEME_LABELS[system.appearance]) })
                  : t(THEME_LABELS[value])}
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
        <label style={S.check}>
          <input
            type="checkbox"
            checked={draft.confirmJobRemoval}
            disabled={saving}
            onChange={(e) => setDraft({ ...draft, confirmJobRemoval: e.target.checked })}
          />
          {t("settings.confirmJobRemoval")}
        </label>
        {/* The number sits beside its label, wrapping below it only when the
            label leaves it no room. */}
        <div style={S.fontField}>
          <label style={S.inlineField}>
            <span style={S.fontLabel}>{t("settings.cardRowLimit")}</span>
            <input
              type="number"
              min={CARD_ROW_LIMIT_RANGE.min}
              max={CARD_ROW_LIMIT_RANGE.max}
              value={draft.cardRowLimit}
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, cardRowLimit: Number(e.target.value) })}
              style={S.limitInput}
            />
          </label>
          <span style={S.fontHint}>{t("settings.cardRowLimitHint")}</span>
        </div>
      </div>
      <div {...tablist.panelProps("parameters")} hidden={tab !== "parameters"}>
        {/* The defaults every new job starts with, under their own heading, with
            their reset closing the group as in the fleet's other Settings, so it
            plainly covers these and nothing above (config-sets conventions,
            Reset: one control per group, named for it). */}
        <section>
          <p style={S.sectionHint}>{t("settings.defaultParametersHint")}</p>
          <OptionsPanel
            options={draft.defaults}
            onChange={(o) => setDraft({ ...draft, defaults: o })}
            disabled={saving}
          />
          <div style={S.resetRow}>
            <button style={S.resetDefaultParameters} disabled={saving} onClick={resetDefaultParameters}>
              {t("settings.resetParameters")}
            </button>
          </div>
        </section>
      </div>
      {/* The list new jobs leave out, edited whole and checked in order, with
          its own reset (config-sets conventions, Reset: one per group). */}
      <div {...tablist.panelProps("exclusions")} hidden={tab !== "exclusions"}>
        <p style={S.sectionHint}>{t("exclusions.hint")}</p>
        <ExclusionList
          patterns={draft.defaults.exclusions}
          onChange={(exclusions) => setDraft({ ...draft, defaults: { ...draft.defaults, exclusions } })}
          disabled={saving}
        />
        <div style={S.resetRow}>
          <button style={S.resetDefaultParameters} disabled={saving} onClick={resetExclusions}>
            {t("exclusions.reset")}
          </button>
        </div>
      </div>
      {saveError && <p role="alert" className="inline-issue" style={S.error}>{t("settings.saveFailed")}</p>}
    </ModalShell>
  );
}

const S: Record<string, CSSProperties> = {
  // The tab strip stays at the top; its labels never wrap or clip.
  tabs: { display: "flex", flexWrap: "wrap", gap: "0.25rem", marginBottom: "1rem", paddingBottom: "0.5rem", borderBottom: "1px solid var(--border)" },
  tab: { whiteSpace: "nowrap", background: "transparent", borderColor: "transparent", color: "var(--text-2)" },
  tabActive: { background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)", fontWeight: 600 },
  sectionHint: { margin: "0 0 0.75rem", fontSize: "0.8rem", color: "var(--text-2)" },
  resetRow: { marginTop: "1rem" },
  // A button's caption never wraps.
  resetDefaultParameters: { whiteSpace: "nowrap" },
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
  check: { display: "flex", alignItems: "center", gap: "0.45rem", marginBottom: "1rem" },
  inlineField: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.35rem 0.75rem" },
  limitInput: { width: "5rem" },
  error: { margin: "1rem 0 0" },
};
