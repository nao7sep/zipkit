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
import { DEFAULT_OPTIONS, type GuiOptions, type GuiSettings } from "../../../shared/spec";

/** Two option sets are equal when every visible field matches — the draft's
 *  dirty check (flat record, so a key-wise compare is exact). */
function optionsEqual(a: GuiOptions, b: GuiOptions): boolean {
  return (Object.keys(DEFAULT_OPTIONS) as (keyof GuiOptions)[]).every((k) => a[k] === b[k]);
}

/** Settings are equal when the option defaults and the UI font both match. */
function settingsEqual(a: GuiSettings, b: GuiSettings): boolean {
  return a.uiFontFamily === b.uiFontFamily && optionsEqual(a.defaults, b.defaults);
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
  onSave: (s: GuiSettings) => void;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  const [draft, setDraft] = useState<GuiSettings>(settings);

  const dirty = !settingsEqual(draft, settings);
  const canSave = dirty && isValid(draft.defaults);

  function save() {
    onSave(draft);
    onClose();
  }

  // Named for exactly what it resets, so the label and the code agree
  // (config-seeding conventions) — "default parameters" is the same phrase the
  // main window's per-job toggle uses for these knobs. It only rewrites the
  // unsaved draft — Save commits it, closing without saving keeps the current
  // settings — so the label is the whole warning and no confirmation is needed.
  // The UI font is deliberately left alone: it is the user's own cosmetic
  // preference, not a built-in that goes stale, so a reset must not drag it
  // along.
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
      title: "Discard unsaved changes?",
      message: "Your changes to the settings have not been saved.",
      confirmLabel: "Discard",
      danger: true,
    });
    if (discard) onClose();
  }

  return (
    <ModalShell
      title="Settings"
      onClose={() => void requestClose()}
      maxWidth="44rem"
      footer={
        // Cancel is first in DOM so the shell's footer-first focus lands on the
        // safe default, never on the reset (which would rewrite the draft on a
        // stray Enter) or the primary Save. The reset button is visually pulled
        // to the far left (flex order + auto margin); Save stays last per the
        // conventions' order.
        <>
          <button onClick={() => void requestClose()}>Cancel</button>
          <button style={S.resetDefaultParameters} onClick={resetDefaultParameters}>
            Reset default parameters
          </button>
          <button className="accent" disabled={!canSave} onClick={save}>
            Save
          </button>
        </>
      }
    >
      {/* Appearance leads: the UI (chrome) font, set apart from the per-job archive knobs below. */}
      <label style={S.fontField}>
        <span style={S.fontLabel}>UI font</span>
        <input
          value={draft.uiFontFamily}
          placeholder="Default"
          onChange={(e) => setDraft({ ...draft, uiFontFamily: e.target.value })}
        />
        <span style={S.fontHint}>
          The app interface font. Comma-separated families; the first one your system has is used.
          Blank uses the built-in default.
        </span>
      </label>
      <OptionsPanel
        options={draft.defaults}
        onChange={(o) => setDraft({ ...draft, defaults: o })}
        disabled={false}
      />
    </ModalShell>
  );
}

const S: Record<string, CSSProperties> = {
  // Reset sits at the far left of the footer, apart from the Cancel/Save pair:
  // the auto margin pushes those two right, the order pulls it ahead of Cancel
  // (which stays first in DOM for the shell's footer-first focus).
  resetDefaultParameters: { order: -1, marginRight: "auto" },
  fontField: { display: "flex", flexDirection: "column", gap: "0.35rem", marginBottom: "1rem" },
  fontLabel: { fontWeight: 600 },
  fontHint: { fontSize: "0.85em", color: "var(--text-2)" },
};
