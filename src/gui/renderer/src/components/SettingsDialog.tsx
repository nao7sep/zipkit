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
import { DEFAULT_OPTIONS, type GuiOptions } from "../../../shared/spec";

/** Two option sets are equal when every visible field matches — the draft's
 *  dirty check (flat record, so a key-wise compare is exact). */
function optionsEqual(a: GuiOptions, b: GuiOptions): boolean {
  return (Object.keys(DEFAULT_OPTIONS) as (keyof GuiOptions)[]).every((k) => a[k] === b[k]);
}

/** The only field that can be made invalid from the UI: the compression level. */
function isValid(o: GuiOptions): boolean {
  return Number.isInteger(o.level) && o.level >= 1 && o.level <= 9;
}

export function SettingsDialog({
  defaults,
  onSave,
  onClose,
}: {
  defaults: GuiOptions;
  onSave: (o: GuiOptions) => void;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  const [draft, setDraft] = useState<GuiOptions>(defaults);

  const dirty = !optionsEqual(draft, defaults);
  const canSave = dirty && isValid(draft);

  function save() {
    onSave(draft);
    onClose();
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
      message: "Your changes to the default options have not been saved.",
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
        // safe default, never on Restore (which would reset the draft on a stray
        // Enter) or the primary Save. Restore is visually pulled to the far left
        // (flex order + auto margin); Save stays last per the conventions' order.
        <>
          <button onClick={() => void requestClose()}>Cancel</button>
          <button style={S.restore} onClick={() => setDraft({ ...DEFAULT_OPTIONS })}>
            Restore defaults
          </button>
          <button className="accent" disabled={!canSave} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <OptionsPanel options={draft} onChange={setDraft} disabled={false} />
    </ModalShell>
  );
}

const S: Record<string, CSSProperties> = {
  // Pulled to the far left of the footer; the auto margin pushes Cancel/Save right.
  restore: { order: -1, marginRight: "auto" },
};
